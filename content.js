(() => {
  window.__instaFlowCleanup?.();
  let frame;
  let timer;
  let pending;
  let enabled = true;
  let autoTimer;
  let automatic = false;
  let seekTimer;
  let seekDeadline;
  let layoutTimer;
  const root = document.documentElement;
  root.classList.add('insta-flow-enabled');
  const toggle = document.createElement('button');
  toggle.className = 'insta-flow-toggle';
  toggle.type = 'button';
  const toolbar = document.createElement('div');
  toolbar.className = 'insta-flow-toolbar';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'Insta Flow 전체화면 및 자동 탐색');
  const autoButton = document.createElement('button');
  autoButton.type = 'button';
  autoButton.textContent = '자동 시작';
  autoButton.setAttribute('aria-pressed', 'false');
  const intervalLabel = document.createElement('label');
  intervalLabel.textContent = '사진 간격 ';
  const seconds = document.createElement('input');
  seconds.type = 'number';
  seconds.min = '1';
  seconds.max = '3600';
  seconds.step = '1';
  seconds.value = '3';
  seconds.setAttribute('aria-label', '자동 이동 간격(초)');
  seconds.title = '사진 표시 시간입니다. 영상은 재생이 끝나면 이동합니다.';
  intervalLabel.append(seconds, '초');
  const order = document.createElement('select');
  order.setAttribute('aria-label', '자동 이동 순서');
  for (const [value, title] of [['forward', '정방향'], ['random', '랜덤']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = title;
    order.appendChild(option);
  }
  const videoLabel = document.createElement('label');
  const videoOnly = document.createElement('input');
  videoOnly.type = 'checkbox';
  videoOnly.setAttribute('aria-label', '사진을 건너뛰고 영상만 보기');
  videoLabel.append(videoOnly, ' 영상만');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  toolbar.append(toggle, autoButton, intervalLabel, order, videoLabel, status);
  document.body.appendChild(toolbar);
  const overlays = new Set();
  const mediaBoxes = new Set();
  const mediaRatios = new WeakMap();
  const labels = {
    back: ['돌아가기', 'Go back', 'Back', 'Previous'],
    next: ['다음', 'Next']
  };
  const getPanel = () => document.querySelector('[role="dialog"] article ._aatk');
  const getPostLinks = () => {
    const seen = new Set();
    return [...document.querySelectorAll('a[href]')].filter(link => {
      const url = new URL(link.href, location.href);
      const match = url.pathname.match(/^\/[^/]+\/(?:p|reel)\/([^/]+)\/?$/);
      if (url.origin !== location.origin || !match || !link.querySelector('img') || seen.has(match[1])) return false;
      seen.add(match[1]);
      return true;
    });
  };
  const adjacentPostLink = direction => {
    const current = location.pathname.match(/\/(?:p|reel)\/([^/]+)/)?.[1];
    const links = getPostLinks();
    const index = links.findIndex(link => new URL(link.href).pathname.includes(`/${current}/`));
    return index < 0 ? undefined : links[index + (direction === 'next' ? 1 : -1)];
  };
  const findButton = (panel, direction, post = false) => {
    const buttons = post
      ? panel.closest('[role="dialog"]').querySelectorAll('button._abl-')
      : panel.querySelectorAll('button');
    return [...buttons].find(button => !button.disabled && button.getClientRects().length &&
      (!post || !panel.contains(button)) &&
      labels[direction].includes(button.getAttribute('aria-label') || button.querySelector('svg')?.getAttribute('aria-label')));
  };
  // A previous post opens at its first slide; walk its native carousel to the end.
  const settlePost = () => {
    if (!pending) return;
    const panel = getPanel();
    if (Date.now() > pending.deadline) { pending = null; return; }
    if (panel && location.pathname !== pending.from) {
      if (!pending.readyAt) pending.readyAt = Date.now() + 400;
      const media = visibleMedia(panel);
      if (Date.now() >= pending.readyAt && media && (media.currentSrc || media.src)) {
        const button = findButton(panel, pending.edge === 'last' ? 'next' : 'back');
        if (button) {
          pending.empty = 0;
          button.click();
          pending.readyAt = Date.now() + 250;
        } else if (++pending.empty >= 3) {
          if (pending.edge === 'first') {
            const url = new URL(location.href);
            if (url.searchParams.has('img_index') && url.searchParams.get('img_index') !== '1') {
              url.searchParams.set('img_index', '1');
              history.replaceState(history.state, '', url);
            }
          }
          pending = null;
          update();
          return;
        }
      }
    }
    timer = setTimeout(settlePost, 150);
  };
  const movePost = (panel, direction, edge) => {
    if (pending) return;
    const button = findButton(panel, direction, true) || adjacentPostLink(direction);
    if (!button) return;
    pending = { from: location.pathname, edge, deadline: Date.now() + 20000, empty: 0 };
    button.click();
    settlePost();
  };
  const rawMoveMedia = direction => {
    if (pending) return;
    const panel = getPanel();
    if (!panel) return;
    const button = findButton(panel, direction);
    if (button) {
      button.click();
      clearTimeout(layoutTimer);
      layoutTimer = setTimeout(update, 400);
    }
    else movePost(panel, direction, direction === 'back' ? 'last' : 'first');
  };
  const visibleMedia = panel => {
    const box = panel.getBoundingClientRect();
    return [...panel.querySelectorAll('video, img')].map(media => {
      const r = media.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, box.right, innerWidth) - Math.max(r.left, box.left, 0)) *
        Math.max(0, Math.min(r.bottom, box.bottom, innerHeight) - Math.max(r.top, box.top, 0));
      return { media, area };
    }).sort((a, b) => b.area - a.area || Number(b.media.tagName === 'VIDEO') - Number(a.media.tagName === 'VIDEO')).find(item => item.area > 0)?.media;
  };
  const seekVideo = (direction = 'next', continuing = false) => {
    clearTimeout(seekTimer);
    if (!enabled || !videoOnly.checked) { status.textContent = ''; return; }
    if (!continuing) seekDeadline = Date.now() + 120000;
    const panel = getPanel();
    if (!panel && !pending) { status.textContent = ''; return; }
    if (Date.now() > seekDeadline) { status.textContent = '영상 탐색 중지'; stopAuto(); return; }
    if (!pending && panel) {
      const media = visibleMedia(panel);
      if (media?.tagName === 'VIDEO') { status.textContent = ''; return; }
      if (media && !findButton(panel, direction) && !findButton(panel, direction, true) && !adjacentPostLink(direction)) {
        status.textContent = '더 이상 영상 없음'; stopAuto(); return;
      }
      if (media) rawMoveMedia(direction);
    }
    status.textContent = '영상 찾는 중…';
    seekTimer = setTimeout(() => seekVideo(direction, true), 450);
  };
  const moveMedia = direction => {
    rawMoveMedia(direction);
    if (videoOnly.checked) {
      clearTimeout(seekTimer);
      seekTimer = setTimeout(() => seekVideo(direction), 450);
    }
  };
  videoOnly.addEventListener('change', () => seekVideo());
  const randomPost = () => {
    const current = location.pathname.match(/\/(?:p|reel)\/([^/]+)/)?.[1];
    const links = getPostLinks().filter(link => !new URL(link.href).pathname.includes(`/${current}/`));
    const panel = getPanel();
    if (!panel || !links.length) { moveMedia('next'); return; }
    const link = links[Math.floor(Math.random() * links.length)];
    pending = { from: location.pathname, edge: 'first', deadline: Date.now() + 20000, empty: 0 };
    link.click();
    settlePost();
  };
  let autoMedia;
  let autoSource;
  let photoDeadline = 0;
  let autoVideo;
  const releaseAutoVideo = () => {
    if (autoVideo) autoVideo.media.loop = autoVideo.loop;
    autoVideo = null;
  };
  const stopAuto = () => {
    automatic = false;
    clearTimeout(autoTimer);
    releaseAutoVideo();
    autoMedia = null;
    autoSource = null;
    autoButton.textContent = '자동 시작';
    autoButton.setAttribute('aria-pressed', 'false');
  };
  const advanceAuto = () => {
    const panel = getPanel();
    if (!panel || pending) return;
    if (order.value === 'random' && !findButton(panel, 'next')) {
      randomPost();
      if (videoOnly.checked) seekTimer = setTimeout(() => seekVideo(), 450);
    } else if (findButton(panel, 'next') || findButton(panel, 'next', true) || adjacentPostLink('next')) {
      moveMedia('next');
    } else stopAuto();
  };
  const finishAutoVideo = video => {
    if (!automatic || !enabled || pending || document.hidden ||
        !autoVideo || autoVideo.media !== video || autoVideo.advanced) return;
    const panel = getPanel();
    if (!panel || visibleMedia(panel) !== video) return;
    autoVideo.advanced = true;
    advanceAuto();
  };
  const watchAutoVideo = media => {
    const source = media.getAttribute('src') || media.currentSrc;
    if (!autoVideo || autoVideo.media !== media || autoVideo.source !== source) {
      releaseAutoVideo();
      autoVideo = { media, source, loop: media.loop, advanced: false };
      if (media.paused && !media.ended) {
        media.play().catch(() => {
          if (automatic && autoVideo?.media === media) status.textContent = '영상 재생 대기';
        });
      }
    }
    // Instagram normally loops clips, which prevents a native ended event.
    if (media.loop) media.loop = false;
  };
  const scheduleAuto = () => {
    clearTimeout(autoTimer);
    if (!automatic) return;
    autoMedia = null;
    autoSource = null;
    const tick = () => {
      if (!automatic) return;
      const panel = getPanel();
      if (!enabled || (!panel && !pending)) { stopAuto(); return; }
      if (!pending && !document.hidden && panel) {
        const media = visibleMedia(panel);
        if (media) {
          const source = location.pathname + '|' + (media.getAttribute('src') || '');
          if (media !== autoMedia || source !== autoSource) {
            autoMedia = media;
            autoSource = source;
            photoDeadline = Date.now() + Math.max(1, Math.min(3600, Number(seconds.value) || 3)) * 1000;
          }
          if (media.tagName === 'VIDEO') {
            watchAutoVideo(media);
            if (media.ended) finishAutoVideo(media);
          } else {
            releaseAutoVideo();
            if (Date.now() >= photoDeadline) {
              photoDeadline = Infinity;
              advanceAuto();
            }
          }
        }
      }
      if (automatic) autoTimer = setTimeout(tick, 150);
    };
    tick();
  };
  const onAutoEnded = event => finishAutoVideo(event.target);
  document.addEventListener('ended', onAutoEnded, true);
  seconds.addEventListener('change', () => {
    seconds.value = String(Math.max(1, Math.min(3600, Number(seconds.value) || 3)));
    scheduleAuto();
  });
  order.addEventListener('change', scheduleAuto);
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const panel = getPanel();
      for (const box of mediaBoxes) if (!box.isConnected) mediaBoxes.delete(box);
      toolbar.hidden = !panel;
      const title = enabled ? '원래 화면' : '전체화면';
      if (toggle.textContent !== title) toggle.textContent = title;
      const toggleLabel = enabled ? '인스타그램 원래 화면으로 복귀' : '사진·영상 전체화면으로 전환';
      if (toggle.getAttribute('aria-pressed') !== String(enabled)) toggle.setAttribute('aria-pressed', String(enabled));
      if (toggle.getAttribute('aria-label') !== toggleLabel) toggle.setAttribute('aria-label', toggleLabel);
      for (const button of overlays) {
        if (!button.isConnected || !panel || button.parentElement !== panel.closest('[role="dialog"]')) {
          button.remove();
          overlays.delete(button);
        }
      }
      if (!panel) return;
      panel.querySelectorAll('video, img').forEach(media => {
        for (let box = media.parentElement; box && box !== panel; box = box.parentElement) {
          if (!box.hasAttribute('data-insta-flow-media-box')) box.setAttribute('data-insta-flow-media-box', '');
          mediaBoxes.add(box);
        }
      });
      const media = visibleMedia(panel);
      if (automatic && !pending && media?.tagName === 'VIDEO') watchAutoVideo(media);
      if (media) {
        const source = media.getAttribute('src') || media.getAttribute('poster') || '';
        let cached = mediaRatios.get(media);
        const measured = (media.videoWidth || media.naturalWidth) / (media.videoHeight || media.naturalHeight);
        if ((!cached || cached.source !== source) && Number.isFinite(measured) && measured > 0) {
          cached = { source, ratio: measured };
          mediaRatios.set(media, cached);
        }
        const ratio = cached?.ratio;
        if (Number.isFinite(ratio) && ratio > 0 && panel.style.getPropertyValue('--insta-flow-media-ratio') !== String(ratio)) {
          panel.style.setProperty('--insta-flow-media-ratio', ratio);
        }
        if (Number.isFinite(ratio) && ratio > 0) {
          const scale = window.devicePixelRatio || 1;
          const availableWidth = document.documentElement.clientWidth;
          const availableHeight = window.innerHeight;
          const width = Math.floor(Math.min(availableWidth, availableHeight * ratio) * scale) / scale;
          const height = Math.floor(Math.min(availableHeight, availableWidth / ratio) * scale) / scale;
          for (const [name, value] of [['--insta-flow-media-width', `${width}px`], ['--insta-flow-media-height', `${height}px`]]) {
            if (panel.style.getPropertyValue(name) !== value) panel.style.setProperty(name, value);
          }
        }
      }
      for (const direction of ['back', 'next']) {
        let button = [...overlays].find(button => button.dataset.direction === direction);
        if (!button) {
          button = document.createElement('button');
          button.className = 'insta-flow-boundary-arrow';
          button.dataset.direction = direction;
          button.textContent = direction === 'back' ? '‹' : '›';
          button.setAttribute('aria-label', direction === 'back' ? '이전 게시물의 마지막 사진' : '다음 게시물의 첫 사진');
          button.title = button.getAttribute('aria-label');
          panel.closest('[role="dialog"]').appendChild(button);
          overlays.add(button);
        }
        button.hidden = !enabled || Boolean(findButton(panel, direction)) || !(findButton(panel, direction, true) || adjacentPostLink(direction));
      }
    });
  };
  const observer = new MutationObserver(records => {
    const changed = records.some(record => {
      const target = record.target;
      if (toolbar.contains(target)) return false;
      if (record.type === 'childList') return true;
      if (record.attributeName === 'style') {
        // Ignore our own ratio writes and cosmetic hover/player-control updates.
        return Boolean(target.closest('._aatk')) &&
          (target.matches('li, ul') || Boolean(target.style.transform) || Boolean(target.style.getPropertyValue('--x-width')));
      }
      return Boolean(target.closest?.('._aatk'));
    });
    if (changed) update();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-label', 'style', 'src', 'srcset', 'loop'] });
  document.addEventListener('load', update, true);
  document.addEventListener('loadedmetadata', update, true);
  document.addEventListener('transitionend', update, true);
  window.addEventListener('resize', update);
  const onKey = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        event.target.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
    const panel = getPanel();
    if (!enabled || !panel || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') moveMedia(event.key === 'ArrowLeft' ? 'back' : 'next');
    else {
      movePost(panel, event.key === 'ArrowUp' ? 'back' : 'next', 'first');
      if (videoOnly.checked) seekTimer = setTimeout(() => seekVideo(event.key === 'ArrowUp' ? 'back' : 'next'), 450);
    }
  };
  document.addEventListener('keydown', onKey, true);
  const onClick = event => {
    if (event.target === autoButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (automatic) stopAuto();
      else {
        if (!enabled) { enabled = true; root.classList.add('insta-flow-enabled'); update(); }
        automatic = true;
        autoButton.textContent = '자동 정지';
        autoButton.setAttribute('aria-pressed', 'true');
        scheduleAuto();
      }
      return;
    }
    if (event.target.closest?.('.insta-flow-toggle') === toggle) {
      event.preventDefault();
      event.stopImmediatePropagation();
      enabled = !enabled;
      if (!enabled) stopAuto();
      if (!enabled) { clearTimeout(seekTimer); status.textContent = ''; }
      root.classList.toggle('insta-flow-enabled', enabled);
      clearTimeout(timer);
      pending = null;
      update();
      return;
    }
    const button = event.target.closest?.('.insta-flow-boundary-arrow');
    if (!button || !overlays.has(button)) {
      const postButton = event.target.closest?.('button._abl-');
      const panel = getPanel();
      if (panel?.contains(event.target)) {
        clearTimeout(layoutTimer);
        layoutTimer = setTimeout(update, 400);
      }
      if (enabled && videoOnly.checked && panel && postButton && !panel.contains(postButton)) {
        const label = postButton.querySelector('svg')?.getAttribute('aria-label');
        if (labels.back.includes(label) || labels.next.includes(label)) {
          clearTimeout(seekTimer);
          seekTimer = setTimeout(() => seekVideo(labels.back.includes(label) ? 'back' : 'next'), 450);
        }
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    moveMedia(button.dataset.direction);
  };
  document.addEventListener('click', onClick, true);
  window.__instaFlowCleanup = () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    stopAuto();
    clearTimeout(seekTimer);
    clearTimeout(layoutTimer);
    pending = null;
    overlays.forEach(button => button.remove());
    mediaBoxes.forEach(box => box.removeAttribute('data-insta-flow-media-box'));
    toolbar.remove();
    root.classList.remove('insta-flow-enabled');
    document.removeEventListener('load', update, true);
    document.removeEventListener('loadedmetadata', update, true);
    document.removeEventListener('transitionend', update, true);
    window.removeEventListener('resize', update);
    document.removeEventListener('ended', onAutoEnded, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('click', onClick, true);
  };
  update();
})();

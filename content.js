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
  let activeProfile;
  let gridJob;
  let disposed = false;
  let captureTimer;
  let profileTimer;
  let idleTimer;
  let restoreCancelled = false;
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
  const collectButton = document.createElement('button');
  collectButton.type = 'button';
  collectButton.textContent = '목록 수집';
  collectButton.title = '프로필 목록을 스크롤하며 게시물 주소를 저장합니다.';
  const catalogStatus = document.createElement('span');
  catalogStatus.setAttribute('role', 'status');
  toolbar.append(toggle, autoButton, intervalLabel, order, videoLabel, collectButton, catalogStatus, status);
  document.body.appendChild(toolbar);
  const overlays = new Set();
  const mediaBoxes = new Set();
  const markedMedia = new Set();
  const hiddenChrome = new Set();
  const mediaRatios = new WeakMap();
  const labels = {
    back: ['돌아가기', 'Go back', 'Back', 'Previous'],
    next: ['다음', 'Next']
  };
  const getPanel = () => document.querySelector('[role="dialog"] article ._aatk');
  const profileAt = pathname => {
    const match = pathname.match(/^\/([\w.]+)(?:\/(reels|tagged))?\/?$/);
    if (!match || /^(accounts|explore|direct|reels|stories|p|reel|about|legal)$/.test(match[1])) return null;
    return `${match[1].toLowerCase()}/${match[2] || 'posts'}`;
  };
  const postId = pathname => pathname.match(/\/(?:p|reel)\/([\w-]+)(?:\/|$)/)?.[1];
  const getPostLinks = () => {
    const seen = new Set();
    const grid = document.querySelector('main, [role="main"]');
    return [...(grid?.querySelectorAll('a[href]') || [])].filter(link => {
      const url = new URL(link.href, location.href);
      const id = postId(url.pathname);
      if (url.origin !== location.origin || !/^\/(?:[\w.]+\/)?(?:p|reel)\/[\w-]+\/?$/.test(url.pathname) ||
          !id || link.closest('[role="dialog"]') || !link.querySelector('img') || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
  const readGrid = () => getPostLinks().map(link => {
    const url = new URL(link.href);
    return { id: postId(url.pathname), path: url.pathname.replace(/\/?$/, '/') };
  });
  const refreshCatalogStatus = () => {
    const count = activeProfile ? catalog.entries(activeProfile).size : 0;
    catalogStatus.textContent = activeProfile ? `${catalog.error ? '임시 목록' : '저장 목록'} ${count}개` : '';
  };
  const catalog = new InstaFlowCatalog.PostCatalog(refreshCatalogStatus);
  const randomQueue = new InstaFlowCatalog.RandomPostQueue();
  const captureGrid = () => {
    if (activeProfile && (profileAt(location.pathname) || getPanel())) catalog.add(activeProfile, readGrid());
  };
  const refreshProfile = () => {
    const profile = profileAt(location.pathname);
    // Keep the originating grid's identity while its post modal is open.
    const next = profile || (postId(location.pathname) ? activeProfile : null);
    if (next === activeProfile) return;
    gridJob?.controller.abort();
    activeProfile = next;
    status.textContent = '';
    if (next) catalog.sync(next);
    refreshCatalogStatus();
  };
  const gridWait = signal => new Promise(resolve => {
    const done = () => { clearTimeout(timeout); signal.removeEventListener('abort', done); resolve(); };
    const timeout = setTimeout(done, 1000);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
  const runGridScan = (job, target) => InstaFlowCatalog.scanGrid({
    signal: job.controller.signal,
    read: () => {
      if (activeProfile !== job.profile || profileAt(location.pathname) !== job.profile || getPanel()) job.controller.abort();
      return readGrid();
    },
    position: () => {
      const scrolling = document.scrollingElement;
      return { top: scrolling.scrollTop, height: scrolling.scrollHeight, viewport: innerHeight };
    },
    scroll: top => window.scrollTo({ top: top ? 0 : window.scrollY + innerHeight * .8, behavior: 'instant' }),
    wait: gridWait,
    onProgress: posts => {
      if (activeProfile === job.profile) catalog.add(job.profile, posts);
    },
    target,
    timeout: target ? 120000 : 600000
  });
  const resetGridJob = job => {
    if (gridJob !== job) return;
    gridJob = null;
    collectButton.textContent = '목록 수집';
    if (!disposed) update();
  };
  const collectGrid = async () => {
    if (gridJob) {
      gridJob.controller.abort();
      if (gridJob.navigation) stopAuto('탐색 중지');
      return;
    }
    if (!activeProfile || getPanel()) return;
    const job = { controller: new AbortController(), profile: activeProfile };
    gridJob = job;
    collectButton.textContent = '수집 중지';
    status.textContent = '목록 수집 중…';
    try {
      const result = await runGridScan(job);
      await catalog.queue;
      if (!disposed && activeProfile === job.profile) {
        status.textContent = result.reason === 'quiet' ? '새 항목 없음 · 전체 수집 여부는 확인할 수 없습니다' :
          result.reason === 'timeout' ? '수집 시간 초과 · 수집한 목록은 유지됩니다' : '수집 중지';
      }
    } catch {
      if (!disposed) status.textContent = '목록 수집 실패 · 다시 시도해 주세요';
    } finally { resetGridJob(job); }
  };
  const playbackMessage = async (action, extra = {}) => {
    const result = await chrome.runtime.sendMessage({ type: 'insta-flow-playback', action, ...extra });
    if (!result || result.error) throw Error('playback storage');
    return result;
  };
  const savePlayback = async target => {
    if (!automatic) return true;
    try {
      await playbackMessage('set', { state: {
        target, profile: activeProfile || null, order: order.value,
        seconds: Math.max(1, Math.min(3600, Number(seconds.value) || 3)), videoOnly: videoOnly.checked,
        shuffle: activeProfile ? randomQueue.snapshot(activeProfile) : null
      } });
      return automatic && !disposed;
    } catch {
      stopAuto('자동 이동 상태를 저장하지 못해 중지했습니다 · 확장 프로그램을 새로고침해 주세요');
      return false;
    }
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
  const findCloseButton = panel => {
    // Instagram can put Close beside the inner dialog rather than inside it.
    const dialog = panel.closest('[role="dialog"]');
    for (let scope = dialog; scope && scope !== document.documentElement; scope = scope.parentElement) {
      const candidates = [...scope.querySelectorAll('button, [role="button"]')].filter(button =>
        !button.disabled && !panel.contains(button) && button.getClientRects().length &&
        ['Close', '닫기'].includes(button.getAttribute('aria-label') || button.querySelector('svg')?.getAttribute('aria-label')));
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) return null;
      if (scope === document.body) break;
    }
    return null;
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
          playbackMessage('clear').catch(() => {});
          update();
          return;
        }
      }
    }
    timer = setTimeout(settlePost, 150);
  };
  const movePost = async (panel, direction, edge) => {
    if (pending) return;
    const button = findButton(panel, direction, true) || adjacentPostLink(direction);
    if (!button) return;
    pending = { from: location.pathname, edge, deadline: Date.now() + 20000, empty: 0 };
    if (button.tagName === 'A' && !await savePlayback(postId(new URL(button.href).pathname))) { pending = null; return; }
    if (disposed) return;
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
  const isPostMedia = media => {
    if (media.closest('header')) return false;
    if (media.tagName === 'VIDEO') return true;
    if (/profile (?:picture|photo)|프로필\s*사진/i.test(media.alt || '')) return false;
    const link = media.closest('a[href]');
    return !link || !profileAt(new URL(link.href, location.href).pathname);
  };
  const postMedia = panel => [...panel.querySelectorAll('video, img')].filter(isPostMedia);
  const markViewer = panel => {
    // Responsive layouts can place author headers before or inside the media panel.
    for (const node of hiddenChrome) {
      if (!node.isConnected) hiddenChrome.delete(node);
    }
    for (const node of markedMedia) {
      if (!node.isConnected || !panel.contains(node) || !isPostMedia(node)) {
        node.removeAttribute('data-insta-flow-post-media');
        markedMedia.delete(node);
      }
    }
    for (const box of mediaBoxes) {
      if (!box.isConnected || !panel.contains(box) || !postMedia(box).length) {
        box.removeAttribute('data-insta-flow-media-box');
        mediaBoxes.delete(box);
      }
    }
    const desiredChrome = new Set();
    const hide = node => desiredChrome.add(node);
    const article = panel.closest('article');
    for (let child = panel; child && child !== article; child = child.parentElement) {
      for (const sibling of child.parentElement.children) if (sibling !== child) hide(sibling);
    }
    panel.querySelectorAll('img, video, header').forEach(node => {
      if (node.tagName === 'HEADER' || !isPostMedia(node)) hide(node);
    });
    for (const node of hiddenChrome) {
      if (!desiredChrome.has(node)) {
        node.removeAttribute('data-insta-flow-viewer-chrome');
        hiddenChrome.delete(node);
      }
    }
    for (const node of desiredChrome) {
      if (!node.hasAttribute('data-insta-flow-viewer-chrome')) node.setAttribute('data-insta-flow-viewer-chrome', '');
      hiddenChrome.add(node);
    }
    postMedia(panel).forEach(media => {
      if (!media.hasAttribute('data-insta-flow-post-media')) media.setAttribute('data-insta-flow-post-media', '');
      markedMedia.add(media);
      for (let box = media.parentElement; box && box !== panel; box = box.parentElement) {
        if (!box.hasAttribute('data-insta-flow-media-box')) box.setAttribute('data-insta-flow-media-box', '');
        mediaBoxes.add(box);
      }
    });
  };
  const visibleMedia = panel => {
    const box = panel.getBoundingClientRect();
    return postMedia(panel).map(media => {
      const r = media.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, box.right, innerWidth) - Math.max(r.left, box.left, 0)) *
        Math.max(0, Math.min(r.bottom, box.bottom, innerHeight) - Math.max(r.top, box.top, 0));
      return { media, area };
    }).sort((a, b) => b.area - a.area || Number(b.media.tagName === 'VIDEO') - Number(a.media.tagName === 'VIDEO')).find(item => item.area > 0)?.media;
  };
  const seekVideo = (direction = 'next', continuing = false) => {
    clearTimeout(seekTimer);
    if (gridJob?.navigation) return;
    if (!enabled || !videoOnly.checked) { status.textContent = ''; return; }
    if (!continuing) seekDeadline = Date.now() + 120000;
    const panel = getPanel();
    if (!panel && !pending) { status.textContent = ''; return; }
    if (Date.now() > seekDeadline) { stopAuto('영상 탐색 중지'); return; }
    if (!pending && panel) {
      const media = visibleMedia(panel);
      if (media?.tagName === 'VIDEO') { status.textContent = ''; return; }
      if (media && !findButton(panel, direction) && !findButton(panel, direction, true) && !adjacentPostLink(direction)) {
        stopAuto('더 이상 영상 없음'); return;
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
  const randomPost = async () => {
    if (gridJob || pending) return;
    captureGrid();
    const current = postId(location.pathname);
    const panel = getPanel();
    if (!panel || !activeProfile) { moveMedia('next'); return; }
    const profile = activeProfile;
    await catalog.queue;
    if (!automatic || disposed || activeProfile !== profile || !getPanel() || postId(location.pathname) !== current) return;
    const target = randomQueue.next(profile, [...catalog.entries(profile).values()], current);
    if (!target) { moveMedia('next'); return; }
    const open = async link => {
      pending = { from: location.pathname, edge: 'first', deadline: Date.now() + 20000, empty: 0 };
      if (!await savePlayback(target.id)) { pending = null; return; }
      if (disposed) return;
      link.click();
      settlePost();
    };
    let link = getPostLinks().find(link => postId(new URL(link.href).pathname) === target.id);
    if (link) { await open(link); return; }
    // Use Instagram's real grid link, rather than relying on private router internals.
    const close = findCloseButton(panel);
    if (!close) { stopAuto('저장 게시물을 열려면 프로필 목록으로 돌아가 주세요'); return; }
    const job = { controller: new AbortController(), profile, navigation: true };
    gridJob = job;
    collectButton.textContent = '탐색 중지';
    collectButton.disabled = false;
    status.textContent = '저장된 게시물 찾는 중…';
    try {
      close.click();
      for (let count = 0; count < 10 && getPanel() && !job.controller.signal.aborted; count++) await gridWait(job.controller.signal);
      if (job.controller.signal.aborted) return;
      if (getPanel() || profileAt(location.pathname) !== profile) throw new Error('grid unavailable');
      const result = await runGridScan(job, target.id);
      if (job.controller.signal.aborted || !automatic) return;
      link = result.reason === 'found' && getPostLinks().find(link => postId(new URL(link.href).pathname) === target.id);
      if (!link) throw new Error('post unavailable');
      status.textContent = '';
      await open(link);
    } catch {
      if (!disposed) {
        stopAuto('저장 게시물을 찾지 못했습니다 · 목록을 갱신해 주세요');
      }
    } finally { resetGridJob(job); }
  };
  let autoMedia;
  let autoSource;
  let photoDeadline = 0;
  let autoVideo;
  let missingPanelSince = 0;
  const releaseAutoVideo = () => {
    if (autoVideo) autoVideo.media.loop = autoVideo.loop;
    autoVideo = null;
  };
  const stopAuto = reason => {
    automatic = false;
    missingPanelSince = 0;
    if (reason) status.textContent = reason;
    console.info('[Insta Flow] 자동 정지:', reason || (disposed ? '스크립트 정리' : '사용자 조작 또는 탐색 종료'));
    if (!disposed) playbackMessage('clear').catch(() => {});
    if (gridJob?.navigation) gridJob.controller.abort();
    clearTimeout(autoTimer);
    releaseAutoVideo();
    autoMedia = null;
    autoSource = null;
    autoButton.textContent = '자동 시작';
    autoButton.setAttribute('aria-pressed', 'false');
  };
  const advanceAuto = () => {
    const panel = getPanel();
    if (!panel || pending || gridJob) return;
    if (order.value === 'random' && !findButton(panel, 'next')) {
      randomPost().then(() => {
        if (automatic && videoOnly.checked && !gridJob) seekTimer = setTimeout(() => seekVideo(), 450);
      });
    } else if (findButton(panel, 'next') || findButton(panel, 'next', true) || adjacentPostLink('next')) {
      moveMedia('next');
    } else stopAuto('다음 게시물 없음 · 자동 이동 중지');
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
      if (gridJob?.navigation) { autoTimer = setTimeout(tick, 150); return; }
      if (!enabled) { stopAuto('원래 화면으로 전환하여 자동 이동 중지'); return; }
      if (!panel && !pending) {
        // React may temporarily replace the viewer DOM without leaving the post.
        if (!postId(location.pathname)) { stopAuto('게시물 화면을 벗어나 자동 이동 중지'); return; }
        if (!missingPanelSince) missingPanelSince = Date.now();
        if (Date.now() - missingPanelSince >= 2000) { stopAuto('게시물 화면을 찾지 못해 자동 이동 중지'); return; }
        autoMedia = null;
        autoSource = null;
        autoTimer = setTimeout(tick, 150);
        return;
      }
      missingPanelSince = 0;
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
      refreshProfile();
      toolbar.hidden = !panel && !profileAt(location.pathname) && !gridJob && !(postId(location.pathname) && status.textContent);
      for (const control of [toggle, autoButton, intervalLabel, order, videoLabel]) control.hidden = !panel;
      collectButton.disabled = (Boolean(panel) || !profileAt(location.pathname)) && !gridJob;
      refreshCatalogStatus();
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
      markViewer(panel);
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
    if (changed) {
      update();
      if (!captureTimer) captureTimer = setTimeout(() => { captureTimer = null; captureGrid(); }, 500);
    }
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
    if (gridJob || !enabled || !panel || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
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
    if (event.target === collectButton) {
      event.preventDefault();
      event.stopImmediatePropagation();
      collectGrid();
      return;
    }
    if (event.target === autoButton) {
      restoreCancelled = true;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (automatic) { stopAuto('자동 이동을 정지했습니다'); pending = null; clearTimeout(timer); }
      else {
        if (!enabled) { enabled = true; root.classList.add('insta-flow-enabled'); update(); }
        automatic = true;
        missingPanelSince = 0;
        status.textContent = '';
        autoButton.textContent = '자동 정지';
        autoButton.setAttribute('aria-pressed', 'true');
        scheduleAuto();
      }
      return;
    }
    if (event.target.closest?.('.insta-flow-toggle') === toggle) {
      restoreCancelled = true;
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
  const showControls = () => {
    root.classList.remove('insta-flow-controls-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => root.classList.add('insta-flow-controls-idle'), 2500);
  };
  document.addEventListener('pointermove', showControls, { passive: true });
  document.addEventListener('pointerdown', showControls, { passive: true });
  document.addEventListener('keydown', showControls, true);
  document.addEventListener('focusin', showControls);
  showControls();
  const restorePlayback = async () => {
    try {
      const target = postId(location.pathname);
      const { state } = await playbackMessage('take', { target });
      if (!state || disposed || restoreCancelled) return;
      const until = Date.now() + 20000;
      while (!getPanel() && postId(location.pathname) === target && Date.now() < until && !disposed && !restoreCancelled) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (disposed || restoreCancelled || postId(location.pathname) !== target) return;
      if (!getPanel()) { stopAuto('이 게시물 화면에서는 자동 재생을 복원할 수 없습니다 · 프로필에서 게시물을 다시 열어 주세요'); update(); return; }
      activeProfile = state.profile;
      if (activeProfile) randomQueue.restore(activeProfile, state.shuffle);
      if (activeProfile) await catalog.sync(activeProfile);
      if (disposed) return;
      order.value = state.order;
      seconds.value = String(state.seconds);
      videoOnly.checked = Boolean(state.videoOnly);
      if (restoreCancelled) return;
      automatic = true;
      autoButton.textContent = '자동 정지';
      autoButton.setAttribute('aria-pressed', 'true');
      status.textContent = '페이지 이동 후 자동 재생 복원';
      console.info('[Insta Flow] 페이지 이동 후 자동 재생 복원');
      showControls();
      scheduleAuto();
      update();
    } catch (error) {
      console.warn('[Insta Flow] 자동 재생 복원 상태 확인 실패:', error.message);
    }
  };
  console.info('[Insta Flow] 0.4.3 초기화');
  restorePlayback();
  profileTimer = setInterval(() => { refreshProfile(); captureGrid(); update(); }, 1000);
  window.__instaFlowCleanup = () => {
    disposed = true;
    gridJob?.controller.abort();
    clearTimeout(captureTimer);
    clearInterval(profileTimer);
    clearTimeout(idleTimer);
    root.classList.remove('insta-flow-controls-idle');
    document.removeEventListener('pointermove', showControls);
    document.removeEventListener('pointerdown', showControls);
    document.removeEventListener('keydown', showControls, true);
    document.removeEventListener('focusin', showControls);
    observer.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    stopAuto();
    clearTimeout(seekTimer);
    clearTimeout(layoutTimer);
    pending = null;
    overlays.forEach(button => button.remove());
    mediaBoxes.forEach(box => box.removeAttribute('data-insta-flow-media-box'));
    markedMedia.forEach(media => media.removeAttribute('data-insta-flow-post-media'));
    hiddenChrome.forEach(node => node.removeAttribute('data-insta-flow-viewer-chrome'));
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

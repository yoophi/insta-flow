const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const source = name => fs.readFileSync(`${__dirname}/../${name}.js`, 'utf8');

function storageWorker(initial = {}) {
  const data = structuredClone(initial);
  const listeners = [];
  const session = {};
  let fail = false;
  const chrome = {
    runtime: { id: 'test', onMessage: { addListener: callback => { listeners.push(callback); } } },
    storage: { session: {
      get: async key => structuredClone({ [key]: session[key] }),
      set: async records => Object.assign(session, structuredClone(records)),
      remove: async key => { delete session[key]; }
    }, local: {
      get: async key => { await new Promise(resolve => setTimeout(resolve, 1)); return structuredClone({ [key]: data[key] }); },
      set: async records => { if (fail) throw Error('quota'); Object.assign(data, structuredClone(records)); }
    } }
  };
  vm.runInNewContext(source('background'), { chrome });
  return {
    data, setFail: value => { fail = value; },
    send: (message, tabId = 1) => new Promise(resolve => {
      for (const listener of listeners) listener(message, { id: 'test', tab: { id: tabId } }, resolve);
    })
  };
}
const post = id => ({ id, path: `/p/${id}/` });

test('worker merges concurrent tab writes, isolates profiles and survives a quota failure', async () => {
  const worker = storageWorker();
  const send = (profile, posts) => worker.send({ type: 'insta-flow-catalog', profile, posts });
  await Promise.all([send('alice/posts', [post('A')]), send('alice/posts', [post('B'), post('A')]), send('bob/posts', [post('C')])]);
  assert.deepEqual(worker.data['catalog:v1:alice/posts'].posts.map(p => p.id), ['A', 'B']);
  assert.deepEqual(worker.data['catalog:v1:bob/posts'].posts.map(p => p.id), ['C']);
  await send('alice/posts', [{ id: 'X', path: 'https://evil.example/p/X/' }, { id: 'Y', path: '/p/Z/' }]);
  assert.equal(worker.data['catalog:v1:alice/posts'].posts.length, 2);
  worker.setFail(true);
  assert.ok((await send('alice/posts', [post('D')])).error);
  worker.setFail(false);
  assert.equal((await send('alice/posts', [post('E')])).posts.length, 3);
});

test('catalog restores persisted candidates, deduplicates discoveries and keeps memory on failure', async () => {
  const worker = storageWorker({ 'catalog:v1:alice/posts': { posts: [post('A')] } });
  const context = { chrome: { runtime: { sendMessage: worker.send } } };
  vm.runInNewContext(source('catalog'), context);
  const catalog = new context.InstaFlowCatalog.PostCatalog(() => {});
  await catalog.sync('alice/posts');
  assert.equal(catalog.entries('alice/posts').size, 1);
  worker.setFail(true);
  await catalog.add('alice/posts', [post('B'), post('B')]);
  assert.equal(catalog.entries('alice/posts').size, 2);
  assert.equal(catalog.error, true);
  worker.setFail(false);
  await catalog.sync('alice/posts');
  assert.equal(catalog.error, false);
  assert.equal(worker.data['catalog:v1:alice/posts'].posts.length, 2);
});

test('scanner accumulates virtualized pages, finds offscreen targets and supports cancellation', async () => {
  const context = {};
  vm.runInNewContext(source('catalog'), context);
  const { scanGrid } = context.InstaFlowCatalog;
  let page = 0;
  const seen = new Set();
  const controller = new AbortController();
  const options = {
    signal: controller.signal, read: () => [post(String(page))],
    scroll: top => { page = top ? 0 : Math.min(page + 1, 3); },
    position: () => ({ top: page * 100, height: 400, viewport: 100 }),
    wait: async () => {}, onProgress: posts => posts.forEach(p => seen.add(p.id))
  };
  assert.equal((await scanGrid({ ...options, target: '3' })).reason, 'found');
  assert.deepEqual([...seen], ['0', '1', '2', '3']);
  assert.equal((await scanGrid(options)).reason, 'quiet');
  assert.equal((await scanGrid({ ...options, timeout: 0 })).reason, 'timeout');
  controller.abort();
  assert.equal((await scanGrid(options)).reason, 'cancelled');
});

async function until(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
function fixture(worker, setup) {
  const dom = new JSDOM('<main></main>', { url: 'https://www.instagram.com/alice/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.chrome = { runtime: { sendMessage: worker.send } };
  let top = 0;
  Object.defineProperty(w.document, 'scrollingElement', { value: w.document.documentElement });
  Object.defineProperty(w.document.documentElement, 'scrollTop', { get: () => top });
  Object.defineProperty(w.document.documentElement, 'scrollHeight', { get: () => 1600 });
  Object.defineProperty(w, 'scrollY', { get: () => top });
  Object.defineProperty(w, 'innerHeight', { value: 800 });
  const rect = () => ({ left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600 });
  w.HTMLElement.prototype.getBoundingClientRect = rect;
  w.HTMLElement.prototype.getClientRects = () => [rect()];
  const main = w.document.querySelector('main');
  function render(id) { main.innerHTML = `<a href="/p/${id}/"><img src="/${id}.jpg"></a>`; }
  w.scrollTo = options => { top = Math.min(options.top, 800); render(top >= 600 ? 'B' : 'A'); };
  function open(id) {
    w.document.querySelector('[role="dialog"]')?.remove();
    w.history.pushState({}, '', `/alice/p/${id}/`);
    const dialog = w.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = `<button aria-label="Close">Close</button><article><div class="_aatk"><img src="/${id}.jpg"></div></article>`;
    dialog.querySelector('button').onclick = () => { dialog.remove(); w.history.pushState({}, '', '/alice/'); render('A'); };
    w.document.body.append(dialog);
  }
  main.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link) { event.preventDefault(); open(link.pathname.split('/')[2]); }
  });
  render('A');
  // Speed up grid polling while leaving photo deadlines and settling real.
  const realTimeout = w.setTimeout.bind(w);
  w.setTimeout = (callback, delay, ...args) => realTimeout(callback, delay === 1000 ? 20 : delay, ...args);
  w.eval(source('catalog'));
  if (setup) setup({ w, open, render });
  w.eval(source('content'));
  return { w, dom, open, render };
}

test('random playback restores a saved offscreen post through its native grid link', async t => {
  const worker = storageWorker({ 'catalog:v1:alice/posts': { posts: [post('B')] } });
  const { w, dom, open } = fixture(worker);
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 2개'), 'catalog did not restore');
  // Instagram may update the route before rendering the modal.
  w.history.pushState({}, '', '/alice/p/A/');
  w.document.querySelector('main').setAttribute('data-loading', 'true');
  await new Promise(resolve => setTimeout(resolve, 1100));
  open('A');
  await until(() => !w.document.querySelector('.insta-flow-toggle').hidden, 'modal controls missing');
  const order = w.document.querySelector('select');
  order.value = 'random';
  w.document.querySelector('input[type="number"]').value = '1';
  const auto = [...w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작');
  auto.click();
  await until(() => w.location.pathname === '/alice/p/B/', 'saved offscreen target was not reopened');
  assert.equal(auto.getAttribute('aria-pressed'), 'true');
  assert.ok(w.document.querySelector('[role="dialog"] article ._aatk'));
  auto.click();
});

test('profile collection persists pages and cancels without losing discoveries', async t => {
  const worker = storageWorker();
  const { w, dom } = fixture(worker);
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 1개'), 'initial grid missing');
  const collect = [...w.document.querySelectorAll('button')].find(b => b.textContent === '목록 수집');
  collect.click();
  await until(() => w.document.body.textContent.includes('저장 목록 2개'), 'collection skipped second page');
  collect.click();
  await until(() => collect.textContent === '목록 수집', 'collection did not cancel');
  assert.deepEqual(worker.data['catalog:v1:alice/posts'].posts.map(p => p.id).sort(), ['A', 'B']);
  w.history.pushState({}, '', '/bob/');
  w.document.querySelector('main').innerHTML = '<a href="/reel/C/"><img src="/C.jpg"></a>';
  await until(() => worker.data['catalog:v1:bob/posts']?.posts.length === 1, 'new profile was not captured');
  assert.equal(worker.data['catalog:v1:bob/posts'].posts[0].id, 'C');
  assert.equal(worker.data['catalog:v1:alice/posts'].posts.length, 2);
});

test('unavailable modal close stops automatic playback with an explanation', async t => {
  const worker = storageWorker({ 'catalog:v1:alice/posts': { posts: [post('B')] } });
  const { w, dom, open } = fixture(worker);
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 2개'), 'catalog missing');
  open('A');
  w.document.querySelector('[aria-label="Close"]').remove();
  await until(() => !w.document.querySelector('.insta-flow-toggle').hidden, 'modal missing');
  w.document.querySelector('select').value = 'random';
  w.document.querySelector('input[type="number"]').value = '1';
  const auto = [...w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작');
  auto.click();
  await until(() => w.document.body.textContent.includes('프로필 목록으로 돌아가 주세요'), 'missing failure explanation');
  assert.equal(auto.getAttribute('aria-pressed'), 'false');
  assert.equal(w.location.pathname, '/alice/p/A/');
});

test('offscreen post search can be cancelled without reopening a different post', async t => {
  const worker = storageWorker({ 'catalog:v1:alice/posts': { posts: [post('Z')] } });
  const { w, dom, open } = fixture(worker);
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 2개'), 'catalog missing');
  open('A');
  await until(() => !w.document.querySelector('.insta-flow-toggle').hidden, 'modal missing');
  w.document.querySelector('select').value = 'random';
  w.document.querySelector('input[type="number"]').value = '1';
  const auto = [...w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작');
  auto.click();
  await until(() => [...w.document.querySelectorAll('button')].some(b => b.textContent === '탐색 중지'), 'search did not start');
  [...w.document.querySelectorAll('button')].find(b => b.textContent === '탐색 중지').click();
  await until(() => w.document.body.textContent.includes('탐색 중지') && auto.getAttribute('aria-pressed') === 'false', 'search did not stop');
  assert.equal(w.location.pathname, '/alice/');
  assert.equal(w.document.querySelector('[role="dialog"]'), null);
});

test('automatic playback remains active across a brief modal rerender', async t => {
  const { w, dom, open } = fixture(storageWorker());
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 1개'), 'profile missing');
  open('A');
  await until(() => !w.document.querySelector('.insta-flow-toggle').hidden, 'modal missing');
  w.document.querySelector('select').value = 'random';
  const auto = [...w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작');
  auto.click();
  assert.equal(auto.getAttribute('aria-pressed'), 'true');
  const article = w.document.querySelector('[role="dialog"] article');
  article.remove();
  await new Promise(resolve => setTimeout(resolve, 350));
  w.document.querySelector('[role="dialog"]').append(article);
  assert.equal(auto.getAttribute('aria-pressed'), 'true', 'brief modal rerender must not stop automatic playback');
});

test('closing the post really stops automatic playback and explains why', async t => {
  const { w, dom, open } = fixture(storageWorker());
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 1개'), 'profile missing');
  open('A');
  await until(() => !w.document.querySelector('.insta-flow-toggle').hidden, 'modal missing');
  w.document.querySelector('select').value = 'random';
  const auto = [...w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작');
  auto.click();
  w.document.querySelector('[aria-label="Close"]').click();
  await until(() => auto.getAttribute('aria-pressed') === 'false', 'playback did not stop on exit');
  assert.ok(w.document.body.textContent.includes('게시물 화면을 벗어나 자동 이동 중지'));
});

test('a permanently missing viewer stops after grace period and leaves a visible reason', async t => {
  const { w, dom, open } = fixture(storageWorker());
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 1개'), 'profile missing');
  open('A');
  await until(() => !w.document.querySelector('.insta-flow-toggle').hidden, 'modal missing');
  w.document.querySelector('select').value = 'random';
  const auto = [...w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작');
  auto.click();
  w.document.querySelector('[role="dialog"] article').remove();
  await until(() => auto.getAttribute('aria-pressed') === 'false', 'missing viewer did not time out');
  assert.ok(w.document.body.textContent.includes('게시물 화면을 찾지 못해 자동 이동 중지'));
  await until(() => !w.document.querySelector('.insta-flow-toolbar').hidden, 'stop reason is hidden');
});

test('random playback settings survive a full document reload caused by a grid link', async t => {
  const worker = storageWorker({ 'catalog:v1:alice/posts': { posts: [post('B')] } });
  const first = fixture(worker);
  let second;
  t.after(() => {
    first.w.__instaFlowCleanup(); first.dom.window.close();
    if (second) { second.w.__instaFlowCleanup(); second.dom.window.close(); }
  });
  await until(() => first.w.document.body.textContent.includes('저장 목록 2개'), 'catalog missing');
  first.open('A');
  await until(() => !first.w.document.querySelector('.insta-flow-toggle').hidden, 'modal missing');
  // Model a native link loading a brand new document instead of React navigation.
  first.w.document.querySelector('main').addEventListener('click', () => {
    first.w.__instaFlowCleanup();
    second = fixture(worker, ({ open }) => open('B'));
  });
  first.w.document.querySelector('select').value = 'random';
  first.w.document.querySelector('input[type="number"]').value = '1';
  [...first.w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작').click();
  await until(() => second, 'native navigation did not happen');
  await until(() => second.w.document.querySelector('.insta-flow-toolbar button[aria-pressed="true"]:not(.insta-flow-toggle)'), 'automatic playback reset on document reload');
  assert.equal(second.w.document.querySelector('select').value, 'random');
  assert.equal(second.w.document.querySelector('input[type="number"]').value, '1');
});

test('overlay controls hide after inactivity and return on pointer or keyboard activity', async t => {
  const { w, dom } = fixture(storageWorker());
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  const root = w.document.documentElement;
  assert.equal(root.classList.contains('insta-flow-controls-idle'), false);
  await until(() => root.classList.contains('insta-flow-controls-idle'), 'controls did not become idle');
  w.document.dispatchEvent(new w.Event('pointermove'));
  assert.equal(root.classList.contains('insta-flow-controls-idle'), false);
  await until(() => root.classList.contains('insta-flow-controls-idle'), 'idle timer did not restart');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(root.classList.contains('insta-flow-controls-idle'), false);
  w.__instaFlowCleanup();
  assert.equal(root.classList.contains('insta-flow-controls-idle'), false);
});

test('playback handoffs are isolated by tab, consumed once and match only the intended post', async () => {
  const worker = storageWorker();
  const state = { target: 'B', profile: 'alice/posts', order: 'random', seconds: 4, videoOnly: true };
  const send = (action, extra, tab) => worker.send({ type: 'insta-flow-playback', action, ...extra }, tab);
  await send('set', { state }, 1);
  assert.equal((await send('take', { target: 'B' }, 2)).state, null);
  assert.equal((await send('take', { target: 'B' }, 1)).state.videoOnly, true);
  assert.equal((await send('take', { target: 'B' }, 1)).state, null);
  await send('set', { state }, 1);
  assert.equal((await send('take', { target: 'C' }, 1)).state, null);
  await send('set', { state }, 1);
  await send('clear', {}, 1);
  assert.equal((await send('take', { target: 'B' }, 1)).state, null);
});

test('narrow viewer excludes profile avatars and centers the post independently of its parent', async t => {
  const { w, dom, open } = fixture(storageWorker());
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 1개'), 'profile missing');
  open('A');
  const panel = w.document.querySelector('._aatk');
  const photo = panel.querySelector('img');
  Object.defineProperties(photo, { naturalWidth: { value: 600 }, naturalHeight: { value: 900 } });
  const header = w.document.createElement('header');
  header.innerHTML = '<a href="/alice/"><img alt="alice profile picture" src="/avatar.jpg"></a>';
  const avatar = header.querySelector('img');
  Object.defineProperties(avatar, { naturalWidth: { value: 150 }, naturalHeight: { value: 150 } });
  panel.prepend(header);
  const author = w.document.createElement('header');
  author.innerHTML = '<a href="/alice/"><img src="/author.jpg"></a>';
  panel.closest('article').prepend(author);
  const style = w.document.createElement('style');
  style.textContent = fs.readFileSync(`${__dirname}/../insta-flow.css`, 'utf8');
  w.document.head.append(style);
  await until(() => panel.style.getPropertyValue('--insta-flow-media-ratio'), 'ratio not measured');
  assert.equal(panel.style.getPropertyValue('--insta-flow-media-ratio'), String(600 / 900));
  assert.equal(header.querySelector('a').hasAttribute('data-insta-flow-media-box'), false);
  assert.equal(w.getComputedStyle(author).display, 'none');
  assert.equal(w.getComputedStyle(panel).position, 'fixed');
  assert.equal(w.getComputedStyle(panel).left, '50%');
  assert.equal(w.getComputedStyle(panel).top, '50%');
  w.document.querySelector('.insta-flow-toggle').click();
  assert.notEqual(w.getComputedStyle(author).display, 'none');
  assert.notEqual(w.getComputedStyle(panel).position, 'fixed');
  w.__instaFlowCleanup();
  assert.equal(w.document.querySelector('[data-insta-flow-viewer-chrome]'), null);
  assert.equal(w.document.querySelector('[data-insta-flow-post-media]'), null);
});

test('random playback finds the modal close button outside the inner dialog', async t => {
  const worker = storageWorker({ 'catalog:v1:alice/posts': { posts: [post('B')] } });
  const { w, dom, open } = fixture(worker);
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 2개'), 'catalog missing');
  open('A');
  const dialog = w.document.querySelector('[role="dialog"]');
  const outer = w.document.createElement('div');
  dialog.before(outer);
  outer.append(dialog.querySelector('[aria-label="Close"]'), dialog);
  await until(() => !w.document.querySelector('.insta-flow-toggle').hidden, 'modal missing');
  w.document.querySelector('select').value = 'random';
  w.document.querySelector('input[type="number"]').value = '1';
  const auto = [...w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작');
  auto.click();
  await until(() => w.location.pathname === '/alice/p/B/', 'outer close button was not found: random playback stopped');
  assert.equal(auto.getAttribute('aria-pressed'), 'true');
});

test('random queue visits every other post once per cycle and resumes the exact remaining order', () => {
  const context = {};
  vm.runInNewContext(source('catalog'), context);
  const Queue = context.InstaFlowCatalog.RandomPostQueue;
  const posts = ['A', 'B', 'C', 'D', 'E'].map(post);
  const queue = new Queue(() => .25);
  let current = 'A';
  const visited = [];
  for (let i = 0; i < 4; i++) {
    const next = queue.next('alice/posts', posts, current);
    assert.notEqual(next.id, current);
    visited.push(next.id);
    current = next.id;
  }
  assert.deepEqual([...visited].sort(), ['B', 'C', 'D', 'E']);
  const nextCycleFirst = queue.next('alice/posts', posts, current);
  assert.notEqual(nextCycleFirst.id, current);
  current = nextCycleFirst.id;
  const restored = new Queue(() => .9);
  restored.restore('alice/posts', queue.snapshot('alice/posts'));
  for (let i = 0; i < 3; i++) {
    const expected = queue.next('alice/posts', posts, current).id;
    assert.equal(restored.next('alice/posts', posts, current).id, expected);
    current = expected;
  }
  assert.equal(queue.next('bob/posts', [post('A')], 'A'), undefined);
});

test('random queue skips deleted and currently viewed posts, and adds new discoveries', () => {
  const context = {};
  vm.runInNewContext(source('catalog'), context);
  const queue = new context.InstaFlowCatalog.RandomPostQueue(() => .99);
  assert.equal(queue.next('alice/posts', ['A', 'B', 'C'].map(post), 'A').id, 'B');
  assert.equal(queue.next('alice/posts', ['A', 'B', 'D'].map(post), 'B').id, 'D');
  assert.equal(queue.next('alice/posts', ['A', 'B', 'D'].map(post), 'D').id, 'A');
});

test('random traversal plays every carousel slide before opening the next post', async t => {
  const worker = storageWorker({ 'catalog:v1:alice/posts': { posts: [post('B')] } });
  const { w, dom, open } = fixture(worker);
  t.after(() => { w.__instaFlowCleanup(); dom.window.close(); });
  await until(() => w.document.body.textContent.includes('저장 목록 2개'), 'catalog missing');
  open('A');
  const panel = w.document.querySelector('._aatk');
  const seen = [1];
  let index = 1;
  const next = w.document.createElement('button');
  next.setAttribute('aria-label', '다음');
  next.onclick = () => {
    index++;
    seen.push(index);
    panel.querySelector('img').src = `/A-${index}.jpg`;
    w.history.replaceState({}, '', `/alice/p/A/?img_index=${index}`);
    if (index === 3) next.remove();
  };
  panel.append(next);
  await until(() => !w.document.querySelector('.insta-flow-toggle').hidden, 'modal missing');
  w.document.querySelector('select').value = 'random';
  w.document.querySelector('input[type="number"]').value = '1';
  const auto = [...w.document.querySelectorAll('button')].find(b => b.textContent === '자동 시작');
  auto.click();
  await until(() => w.location.pathname === '/alice/p/B/', 'next random post was not reached');
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(auto.getAttribute('aria-pressed'), 'true');
});

// Playback handoffs belong to one tab and expire if navigation never completes.
let playbackWrites = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'insta-flow-playback' || sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)) return;
  const key = `playback:v1:${sender.tab.id}`;
  const task = playbackWrites.then(async () => {
    if (message.action === 'set') {
      const state = message.state;
      if (!state || typeof state.target !== 'string' || !/^[\w-]+$/.test(state.target) || !['random', 'forward'].includes(state.order) ||
          typeof state.videoOnly !== 'boolean' || !Number.isFinite(state.seconds) || state.seconds < 1 || state.seconds > 3600 ||
          (state.profile !== null && !/^[a-z0-9._]+\/(posts|reels|tagged)$/.test(state.profile))) throw Error('invalid playback state');
      await chrome.storage.session.set({ [key]: { ...state, expires: Date.now() + 60000 } });
    } else if (message.action === 'take') {
      const state = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      return { state: state?.expires > Date.now() && state.target === message.target ? state : null };
    } else if (message.action === 'clear') {
      await chrome.storage.session.remove(key);
    }
    return {};
  });
  playbackWrites = task.catch(() => {});
  task.then(respond, () => respond({ error: '자동 이동 상태 저장 실패' }));
  return true;
});

// Serialize merges so two Instagram tabs cannot overwrite each other's discoveries.
let writes = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'insta-flow-catalog' || sender.id !== chrome.runtime.id) return;
  const profile = message.profile;
  if (typeof profile !== 'string' || !/^[a-z0-9._]+\/(posts|reels|tagged)$/.test(profile)) return;
  const task = writes.then(async () => {
    const key = `catalog:v1:${profile}`;
    const stored = (await chrome.storage.local.get(key))[key];
    const posts = new Map((stored?.posts || []).map(post => [post.id, post]));
    for (const post of message.posts || []) {
      if (typeof post.id !== 'string' || !/^[\w-]+$/.test(post.id) || typeof post.path !== 'string') continue;
      const match = post.path.match(/^\/(?:[\w.]+\/)?(?:p|reel)\/([\w-]+)\/$/);
      if (match?.[1] !== post.id) continue;
      posts.set(post.id, { id: post.id, path: post.path });
    }
    const result = [...posts.values()];
    if (message.posts?.length) await chrome.storage.local.set({ [key]: { posts: result, updatedAt: Date.now() } });
    return result;
  });
  writes = task.catch(() => {});
  task.then(posts => respond({ posts }), () => respond({ error: '목록 저장 실패' }));
  return true;
});

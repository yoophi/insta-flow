(() => {
  class PostCatalog {
    constructor(onChange) {
      this.profiles = new Map();
      this.onChange = onChange;
      this.error = false;
      this.queue = Promise.resolve();
    }
    entries(profile) {
      if (!this.profiles.has(profile)) this.profiles.set(profile, new Map());
      return this.profiles.get(profile);
    }
    sync(profile, posts = []) {
      const entries = this.entries(profile);
      posts.forEach(post => entries.set(post.id, post));
      this.onChange();
      const task = this.queue.then(async () => {
        try {
          const pending = [...entries.values()];
          const result = await chrome.runtime.sendMessage({ type: 'insta-flow-catalog', profile, posts: pending });
          if (!result || result.error) throw new Error('storage');
          result.posts.forEach(post => entries.set(post.id, post));
          this.error = false;
        } catch {
          this.error = true; // Keep the in-memory list usable if storage is unavailable/full.
        }
        this.onChange();
      });
      this.queue = task;
      return task;
    }
    add(profile, posts) {
      const entries = this.entries(profile);
      const fresh = posts.filter(post => !entries.has(post.id));
      return fresh.length ? this.sync(profile, fresh) : this.queue;
    }
  }
  class RandomPostQueue {
    constructor(random = Math.random) {
      this.random = random;
      this.profiles = new Map();
    }
    shuffled(ids) {
      const result = [...ids];
      for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    }
    next(profile, posts, current) {
      const available = new Set(posts.map(post => post.id));
      const state = this.profiles.get(profile) || { remaining: [], seen: new Set() };
      state.seen.add(current);
      state.remaining = state.remaining.filter(id => available.has(id) && !state.seen.has(id));
      const queued = new Set(state.remaining);
      const added = [...available].filter(id => !state.seen.has(id) && !queued.has(id));
      state.remaining.push(...this.shuffled(added));
      if (!state.remaining.length) {
        state.seen = new Set([current]);
        state.remaining = this.shuffled([...available].filter(id => id !== current));
      }
      const id = state.remaining.shift();
      if (id) state.seen.add(id);
      this.profiles.set(profile, state);
      return posts.find(post => post.id === id);
    }
    snapshot(profile) {
      const state = this.profiles.get(profile);
      return state ? { remaining: [...state.remaining], seen: [...state.seen] } : null;
    }
    restore(profile, saved) {
      if (!saved || !Array.isArray(saved.remaining) || !Array.isArray(saved.seen)) return;
      const valid = ids => [...new Set(ids.filter(id => typeof id === 'string' && /^[\w-]+$/.test(id)))];
      this.profiles.set(profile, { remaining: valid(saved.remaining), seen: new Set(valid(saved.seen)) });
    }
  }
  // A quiet bottom is not proof that Instagram has returned every post.
  const scanGrid = async ({ signal, read, scroll, position, wait, onProgress, target, timeout = 600000 }) => {
    const deadline = Date.now() + timeout;
    let quiet = 0;
    let previous = '';
    if (signal.aborted) return { reason: 'cancelled' };
    scroll(true);
    while (!signal.aborted && Date.now() < deadline) {
      const posts = read();
      if (signal.aborted) return { reason: 'cancelled' };
      onProgress(posts);
      const found = target && posts.find(post => post.id === target);
      if (found) return { reason: 'found', post: found };
      const { top, height, viewport } = position();
      const signature = `${top}:${height}:${posts.map(post => post.id).join(',')}`;
      quiet = top + viewport >= height - 4 && signature === previous ? quiet + 1 : 0;
      if (quiet >= 8) return { reason: 'quiet' };
      previous = signature;
      scroll(false);
      await wait(signal);
    }
    return { reason: signal.aborted ? 'cancelled' : 'timeout' };
  };
  globalThis.InstaFlowCatalog = { PostCatalog, RandomPostQueue, scanGrid };
})();

// Entirely local, deterministic synthetic text. Not a translation corpus.
let nextIndex = 0;
let state = 1;
function random() {
  state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
  return (state >>> 0) / 4294967296;
}
function integer(min, max) { return min + Math.floor(random() * (max - min + 1)); }
function glyphs(length, start, count) {
  // Bounded per-record character array, never a dataset-sized buffer.
  const chars = new Array(length);
  for (let i = 0; i < length; i++) chars[i] = String.fromCharCode(start + integer(0, count - 1));
  return chars.join('');
}
function record() {
  const index = nextIndex++;
  const prefix = String(index).padStart(9, '0') + ' ・ ';
  const kind = integer(0, 99);
  let jp, ko, length, category;
  if (kind < 25) {
    category = 'name'; length = integer(8, 22);
    jp = '星の旅人・'; ko = '별의 여행자・';
  } else if (kind < 75) {
    category = 'effect'; length = integer(100, 240);
    jp = '味方を守る光の技。'; ko = '동료를 지키는 빛의 기술。';
  } else {
    category = 'profile'; length = integer(850, 1700);
    jp = '森を巡る冒険者の記録。'; ko = '숲을 여행하는 모험가의 기록。';
  }
  return {source: prefix + jp + glyphs(length, 0x4e00, 0x9fa5 - 0x4e00 + 1),
    text: prefix + ko + glyphs(length, 0xac00, 11172),
    context: 'synthetic stored ' + category, category};
}
self.onmessage = ({data}) => {
  const {id, type} = data || {};
  try {
    if (type === 'init') {
      state = data.seed >>> 0 || 1; nextIndex = 0;
      self.postMessage({id, ok: true}); return;
    }
    if (type !== 'batch' || !Number.isInteger(data.count) || data.count < 1 || data.count > 256) throw Error('Invalid bounded generator request');
    const start = performance.now();
    const items = Array.from({length: data.count}, record);
    self.postMessage({id, items, generationMs: performance.now() - start});
  } catch (error) { self.postMessage({id, error: {name: error.name, message: error.message}}); }
};

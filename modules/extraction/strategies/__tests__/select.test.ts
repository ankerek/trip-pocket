import { strategyForImageImport, strategyForUrlAfterFetch } from '../select';

describe('strategyForImageImport', () => {
  it('returns ocrTextLLM when force=ocrTextLLM', () => {
    expect(strategyForImageImport('ocrTextLLM')).toBe('ocrTextLLM');
  });
  it('returns vision under auto', () => {
    expect(strategyForImageImport('auto')).toBe('vision');
  });
  it('returns vision under force=vision', () => {
    expect(strategyForImageImport('vision')).toBe('vision');
  });
});

describe('strategyForUrlAfterFetch', () => {
  it('force=ocrTextLLM always wins regardless of file/caption presence', () => {
    expect(strategyForUrlAfterFetch('ocrTextLLM', true, true)).toBe('ocrTextLLM');
    expect(strategyForUrlAfterFetch('ocrTextLLM', true, false)).toBe('ocrTextLLM');
    expect(strategyForUrlAfterFetch('ocrTextLLM', false, true)).toBe('ocrTextLLM');
    expect(strategyForUrlAfterFetch('ocrTextLLM', false, false)).toBe('ocrTextLLM');
  });

  it("no file → ocrTextLLM (vision can't help; caption-only path uses text mode)", () => {
    expect(strategyForUrlAfterFetch('auto', false, true)).toBe('ocrTextLLM');
    expect(strategyForUrlAfterFetch('auto', false, false)).toBe('ocrTextLLM');
    expect(strategyForUrlAfterFetch('vision', false, true)).toBe('ocrTextLLM');
  });

  it('auto: file + caption → captionPlusVision', () => {
    expect(strategyForUrlAfterFetch('auto', true, true)).toBe('captionPlusVision');
  });

  it('auto: file + no caption → vision', () => {
    expect(strategyForUrlAfterFetch('auto', true, false)).toBe('vision');
  });

  it('force=vision: ignores caption — always vision when file is present', () => {
    expect(strategyForUrlAfterFetch('vision', true, true)).toBe('vision');
    expect(strategyForUrlAfterFetch('vision', true, false)).toBe('vision');
  });
});

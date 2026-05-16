import { strategyForImageImport, strategyForUrlAfterFetch } from '../select';

describe('strategyForImageImport', () => {
  it('returns ocrTextLLM when force=ocrTextLLM', () => {
    expect(strategyForImageImport('ocrTextLLM')).toBe('ocrTextLLM');
    expect(strategyForImageImport('ocrTextLLM', true)).toBe('ocrTextLLM');
  });
  it('returns vision under auto with no caption', () => {
    expect(strategyForImageImport('auto')).toBe('vision');
    expect(strategyForImageImport('auto', false)).toBe('vision');
  });
  it('upgrades to captionPlusVision under auto when caption is present', () => {
    expect(strategyForImageImport('auto', true)).toBe('captionPlusVision');
  });
  it('force=vision ignores caption (developer override)', () => {
    expect(strategyForImageImport('vision')).toBe('vision');
    expect(strategyForImageImport('vision', true)).toBe('vision');
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

  describe('with hasVideo', () => {
    it('auto: video + file → videoPlusCaption (caption optional)', () => {
      expect(strategyForUrlAfterFetch('auto', true, true, true)).toBe('videoPlusCaption');
      expect(strategyForUrlAfterFetch('auto', true, false, true)).toBe('videoPlusCaption');
    });

    it('force=video on a real video → videoPlusCaption', () => {
      expect(strategyForUrlAfterFetch('video', true, true, true)).toBe('videoPlusCaption');
      expect(strategyForUrlAfterFetch('video', true, false, true)).toBe('videoPlusCaption');
    });

    it('force=video on a row without video soft-degrades to ocrTextLLM', () => {
      expect(strategyForUrlAfterFetch('video', true, true, false)).toBe('ocrTextLLM');
      expect(strategyForUrlAfterFetch('video', true, false, false)).toBe('ocrTextLLM');
    });

    it('force=vision on a video row wins: developer override stays vision', () => {
      expect(strategyForUrlAfterFetch('vision', true, true, true)).toBe('vision');
    });

    it('force=ocrTextLLM still wins over video', () => {
      expect(strategyForUrlAfterFetch('ocrTextLLM', true, true, true)).toBe('ocrTextLLM');
    });

    it('video without cover file → ocrTextLLM (soft-degrade; videoPlusCaption requires coverFilePath)', () => {
      expect(strategyForUrlAfterFetch('auto', false, true, true)).toBe('ocrTextLLM');
      expect(strategyForUrlAfterFetch('video', false, true, true)).toBe('ocrTextLLM');
    });
  });
});

describe('strategyForImageImport — force=video', () => {
  it('soft-degrades to vision (no video bytes on an image import)', () => {
    expect(strategyForImageImport('video')).toBe('vision');
    expect(strategyForImageImport('video', true)).toBe('vision');
  });
});

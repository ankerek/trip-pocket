// Mock the proxy module since strategies are thin wrappers over it; the goal
// is to verify each strategy translates its input to the right proxy call.
jest.mock('../../proxy', () => ({
  extractFromProxy: jest.fn(),
  extractFromProxyVision: jest.fn(),
}));

import { createOcrThenTextLLM } from '../ocrThenTextLLM';
import { createVisionLLMDirect } from '../visionDirect';
import { createCaptionPlusVision } from '../captionPlusVision';
import { extractFromProxy, extractFromProxyVision } from '../../proxy';

const PROXY = 'https://proxy.example/extract';
const OK: any = { places: [{ name: 'X' }], model: 'gemini' };

beforeEach(() => {
  (extractFromProxy as jest.Mock).mockReset().mockResolvedValue(OK);
  (extractFromProxyVision as jest.Mock).mockReset().mockResolvedValue(OK);
});

describe('OcrThenTextLLM strategy', () => {
  it('sends text-mode payload for text input', async () => {
    const s = createOcrThenTextLLM({ proxyUrl: PROXY });
    await s.extract({ kind: 'text', text: 'hello' });
    expect(extractFromProxy).toHaveBeenCalledWith('hello', PROXY);
  });

  it('uses cached ocrText for image input when present', async () => {
    const ocr = jest.fn();
    const s = createOcrThenTextLLM({ proxyUrl: PROXY, ocr });
    await s.extract({ kind: 'image', filePath: '/img.jpg', ocrText: 'cached' });
    expect(extractFromProxy).toHaveBeenCalledWith('cached', PROXY);
    expect(ocr).not.toHaveBeenCalled();
  });

  it('runs inline OCR when image has no cached ocrText', async () => {
    const ocr = jest.fn().mockResolvedValue('ocr-result');
    const s = createOcrThenTextLLM({ proxyUrl: PROXY, ocr });
    await s.extract({ kind: 'image', filePath: '/img.jpg' });
    expect(ocr).toHaveBeenCalledWith('/img.jpg');
    expect(extractFromProxy).toHaveBeenCalledWith('ocr-result', PROXY);
  });

  it('throws when image has no cached ocrText and no OCR provider', async () => {
    const s = createOcrThenTextLLM({ proxyUrl: PROXY });
    await expect(s.extract({ kind: 'image', filePath: '/img.jpg' })).rejects.toThrow(
      /no cached ocrText/,
    );
  });
});

describe('VisionLLMDirect strategy', () => {
  it('reads the file as base64 and posts vision-mode payload without caption', async () => {
    const readFileBase64 = jest.fn().mockResolvedValue('BASE64_BYTES');
    const s = createVisionLLMDirect({ proxyUrl: PROXY, readFileBase64 });
    await s.extract({ kind: 'image', filePath: '/img.jpg' });
    expect(readFileBase64).toHaveBeenCalledWith('/img.jpg');
    expect(extractFromProxyVision).toHaveBeenCalledWith('BASE64_BYTES', undefined, PROXY);
  });

  it('ignores caption even when present on the input', async () => {
    const readFileBase64 = jest.fn().mockResolvedValue('B64');
    const s = createVisionLLMDirect({ proxyUrl: PROXY, readFileBase64 });
    await s.extract({ kind: 'image', filePath: '/img.jpg', caption: 'should-be-ignored' });
    expect(extractFromProxyVision).toHaveBeenCalledWith('B64', undefined, PROXY);
  });

  it('rejects text input', async () => {
    const s = createVisionLLMDirect({
      proxyUrl: PROXY,
      readFileBase64: jest.fn(),
    });
    await expect(s.extract({ kind: 'text', text: 'no' })).rejects.toThrow(/unsupported input/);
  });
});

describe('CaptionPlusVision strategy', () => {
  it('sends both base64 image and caption', async () => {
    const readFileBase64 = jest.fn().mockResolvedValue('B64');
    const s = createCaptionPlusVision({ proxyUrl: PROXY, readFileBase64 });
    await s.extract({
      kind: 'image',
      filePath: '/img.jpg',
      caption: 'Lunch at Maru Tonkatsu',
    });
    expect(extractFromProxyVision).toHaveBeenCalledWith('B64', 'Lunch at Maru Tonkatsu', PROXY);
  });

  it('sends undefined caption when none provided (degrades to vision-only)', async () => {
    const readFileBase64 = jest.fn().mockResolvedValue('B64');
    const s = createCaptionPlusVision({ proxyUrl: PROXY, readFileBase64 });
    await s.extract({ kind: 'image', filePath: '/img.jpg' });
    expect(extractFromProxyVision).toHaveBeenCalledWith('B64', undefined, PROXY);
  });
});

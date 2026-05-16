// Mock the proxy module since strategies are thin wrappers over it; the goal
// is to verify each strategy translates its input to the right proxy call.
jest.mock('../../proxy', () => {
  const actual = jest.requireActual('../../proxy');
  return {
    ...actual,
    extractFromProxy: jest.fn(),
    extractFromProxyVision: jest.fn(),
    extractFromProxyVideo: jest.fn(),
  };
});

import { createOcrThenTextLLM } from '../ocrThenTextLLM';
import { createVisionLLMDirect } from '../visionDirect';
import { createCaptionPlusVision } from '../captionPlusVision';
import { createVideoPlusCaption } from '../videoPlusCaption';
import {
  extractFromProxy,
  extractFromProxyVision,
  extractFromProxyVideo,
  VideoExtractionError,
} from '../../proxy';

const PROXY = 'https://proxy.example/extract';
const OK: any = { places: [{ name: 'X' }], model: 'gemini' };

beforeEach(() => {
  (extractFromProxy as jest.Mock).mockReset().mockResolvedValue(OK);
  (extractFromProxyVision as jest.Mock).mockReset().mockResolvedValue(OK);
  (extractFromProxyVideo as jest.Mock).mockReset().mockResolvedValue(OK);
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

describe('VideoPlusCaption strategy', () => {
  function makeFallback(): { strategy: any; fn: jest.Mock } {
    const fn = jest.fn().mockResolvedValue({ ...OK });
    return { strategy: { name: 'captionPlusVision', extract: fn }, fn };
  }

  it('sends videoUrl + caption + durationSec to the proxy and returns the result', async () => {
    const { strategy: fallback, fn: fallbackFn } = makeFallback();
    const s = createVideoPlusCaption({ proxyUrl: PROXY, fallback });
    const result = await s.extract({
      kind: 'video',
      videoUrl: 'https://cdn/r.mp4',
      coverFilePath: '/cover.jpg',
      caption: 'best ramen in tokyo',
      durationSec: 28,
    });
    expect(extractFromProxyVideo).toHaveBeenCalledWith(
      'https://cdn/r.mp4',
      'best ramen in tokyo',
      PROXY,
      { durationSec: 28 },
    );
    expect(fallbackFn).not.toHaveBeenCalled();
    expect(result.telemetry?.fallbackUsed).toBeUndefined();
  });

  it('falls back to captionPlusVision on VideoExtractionError and marks telemetry.fallbackUsed', async () => {
    (extractFromProxyVideo as jest.Mock).mockRejectedValueOnce(
      new VideoExtractionError('video-fetch-4xx'),
    );
    const { strategy: fallback, fn: fallbackFn } = makeFallback();
    const s = createVideoPlusCaption({ proxyUrl: PROXY, fallback });
    const result = await s.extract({
      kind: 'video',
      videoUrl: 'https://cdn/r.mp4',
      coverFilePath: '/cover.jpg',
      caption: 'cap',
    });
    expect(fallbackFn).toHaveBeenCalledWith({
      kind: 'image',
      filePath: '/cover.jpg',
      caption: 'cap',
    });
    expect(result.telemetry?.fallbackUsed).toBe(true);
  });

  it('propagates non-video errors without falling back', async () => {
    const otherError = new Error('boom');
    (extractFromProxyVideo as jest.Mock).mockRejectedValueOnce(otherError);
    const { strategy: fallback, fn: fallbackFn } = makeFallback();
    const s = createVideoPlusCaption({ proxyUrl: PROXY, fallback });
    await expect(
      s.extract({
        kind: 'video',
        videoUrl: 'https://cdn/r.mp4',
        coverFilePath: '/cover.jpg',
      }),
    ).rejects.toBe(otherError);
    expect(fallbackFn).not.toHaveBeenCalled();
  });

  it('rejects non-video inputs', async () => {
    const { strategy: fallback } = makeFallback();
    const s = createVideoPlusCaption({ proxyUrl: PROXY, fallback });
    await expect(s.extract({ kind: 'text', text: 'no' })).rejects.toThrow(/unsupported input/);
  });
});

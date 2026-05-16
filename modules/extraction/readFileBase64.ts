import { File } from 'expo-file-system';

/**
 * Read an image file from local storage as a base64 string, suitable for
 * inlining into a worker /extract vision-mode request. The runtime expects a
 * `file://` URI as written by the share extension or importImage.
 *
 * TODO: downscale to 1024px long edge + JPEG q=82 via expo-image-manipulator
 * before encoding. Spec calls for it but the dep isn't currently installed;
 * skipping for now adds a small token-cost overhead per save (still well
 * under $0.001/img on Gemini Flash-Lite). See PR follow-up.
 */
export async function readImageFileAsBase64(filePath: string): Promise<string> {
  return new File(filePath).base64();
}

import { requireOptionalNativeModule } from 'expo-modules-core';

type VisionOCRNative = {
  recognizeText: (imagePath: string) => Promise<string>;
};

// requireOptionalNativeModule returns null in environments where the native
// side isn't registered (Jest, Expo Go, web). Production builds (after
// `npx expo prebuild --clean && npx expo run:ios`) get the real module.
const native = requireOptionalNativeModule('VisionOCR') as VisionOCRNative | null;

export const isVisionOCRAvailable = (): boolean => native !== null;

export const recognizeText = async (imagePath: string): Promise<string> => {
  if (!native) {
    throw new Error(
      '[VisionOCR] native module not registered. Run `npx expo prebuild --clean && npx expo run:ios` to integrate it.',
    );
  }
  return native.recognizeText(imagePath);
};

export default { recognizeText, isVisionOCRAvailable };

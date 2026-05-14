import { useCssElement, useNativeVariable as useFunctionalVariable } from 'react-native-css';
import {
  FlatList as RNFlatList,
  Pressable as RNPressable,
  ScrollView as RNScrollView,
  SectionList as RNSectionList,
  Text as RNText,
  TextInput as RNTextInput,
  View as RNView,
  type FlatListProps,
  type SectionListProps,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { SafeAreaView as RNSafeAreaView } from 'react-native-safe-area-context';
import React from 'react';

// Pressable, ScrollView, FlatList, SectionList have huge prop unions; using
// `as never` on the mapping skips dot-notation inference that otherwise trips
// TS2590 ("union type that is too complex"). Mappings are still validated at
// runtime by react-native-css.
const styleMap = { className: 'style' } as never;
const styleAndContentMap = {
  className: 'style',
  contentContainerClassName: 'contentContainerStyle',
} as never;

export const useCSSVariable =
  process.env.EXPO_OS !== 'web' ? useFunctionalVariable : (variable: string) => `var(${variable})`;

export type ViewProps = React.ComponentProps<typeof RNView> & {
  className?: string;
};

export const View = (props: ViewProps) => {
  return useCssElement(RNView, props, { className: 'style' });
};
View.displayName = 'CSS(View)';

export const SafeAreaView = (
  props: React.ComponentProps<typeof RNSafeAreaView> & { className?: string },
) => {
  return useCssElement(RNSafeAreaView, props, { className: 'style' });
};
SafeAreaView.displayName = 'CSS(SafeAreaView)';

export const Text = (props: React.ComponentProps<typeof RNText> & { className?: string }) => {
  return useCssElement(RNText, props, { className: 'style' });
};
Text.displayName = 'CSS(Text)';

export const Pressable = (
  props: React.ComponentProps<typeof RNPressable> & { className?: string },
): React.ReactElement => {
  return useCssElement(RNPressable as unknown as React.ComponentType<unknown>, props, styleMap);
};
Pressable.displayName = 'CSS(Pressable)';

export const ScrollView = (
  props: React.ComponentProps<typeof RNScrollView> & {
    className?: string;
    contentContainerClassName?: string;
  },
): React.ReactElement => {
  return useCssElement(
    RNScrollView as unknown as React.ComponentType<unknown>,
    props,
    styleAndContentMap,
  );
};
ScrollView.displayName = 'CSS(ScrollView)';

export const TextInput = (
  props: React.ComponentProps<typeof RNTextInput> & { className?: string },
) => {
  return useCssElement(RNTextInput, props, { className: 'style' });
};
TextInput.displayName = 'CSS(TextInput)';

export const Image = (props: React.ComponentProps<typeof ExpoImage> & { className?: string }) => {
  return useCssElement(ExpoImage, props, { className: 'style' });
};
Image.displayName = 'CSS(Image)';

export function FlatList<ItemT>(
  props: FlatListProps<ItemT> & {
    className?: string;
    contentContainerClassName?: string;
  },
): React.ReactElement {
  return useCssElement(
    RNFlatList as unknown as React.ComponentType<unknown>,
    props,
    styleAndContentMap,
  );
}
FlatList.displayName = 'CSS(FlatList)';

export function SectionList<ItemT, SectionT = unknown>(
  props: SectionListProps<ItemT, SectionT> & {
    className?: string;
    contentContainerClassName?: string;
  },
): React.ReactElement {
  return useCssElement(
    RNSectionList as unknown as React.ComponentType<unknown>,
    props,
    styleAndContentMap,
  );
}
SectionList.displayName = 'CSS(SectionList)';

import { type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from '@/tw';
import { Stack, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { cn } from '@/tw/cn';
import { useThemeColors } from '@/tw/theme';
import { OnboardingProgressBar } from './OnboardingProgressBar';

type Props = {
  /** 1-based step among progress-visible screens (1-4 in v2). 0 hides progress. */
  step: number;
  /** Total progress-visible screens (v2: 4). */
  total?: number;
  /** Show the chevron-back top-left affordance. */
  showBack?: boolean;
  /** Headline shown at the top of the scrollable body. */
  headline?: string;
  /** Subhead under the headline. */
  sub?: string;
  /** Body content (selectable options, illustrations, etc.). */
  children: ReactNode;
  /** Sticky bottom bar (CTA buttons). */
  footer?: ReactNode;
  /** When true, body is rendered inside a ScrollView. Use `false` for screens
   *  that manage their own layout (Tinder cards, demo). */
  scroll?: boolean;
};

export function OnboardingScaffold({
  step,
  total = 4,
  showBack = true,
  headline,
  sub,
  children,
  footer,
  scroll = true,
}: Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colors = useThemeColors();

  const Body = scroll ? ScrollView : View;
  const bodyProps = scroll
    ? {
        contentContainerClassName: 'px-6 pt-2 pb-6',
        keyboardShouldPersistTaps: 'handled' as const,
        showsVerticalScrollIndicator: false,
      }
    : { className: 'flex-1 px-6 pt-2 pb-6' };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="bg-bg flex-1" style={{ paddingTop: insets.top }}>
        <View
          className="h-11 flex-row items-center justify-between px-4"
          style={{ marginBottom: 4 }}
        >
          {showBack ? (
            <Pressable
              onPress={() => router.back()}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={12}
              className="h-9 w-9 items-center justify-center"
            >
              <Icon name="chevron.backward" size={22} tintColor={colors.text} />
            </Pressable>
          ) : (
            <View className="h-9 w-9" />
          )}
          <View className="flex-1" />
          <View className="h-9 w-9" />
        </View>
        <OnboardingProgressBar step={step} total={total} />

        <Body {...bodyProps} className={scroll ? undefined : 'flex-1 px-6 pt-2 pb-6'}>
          {headline ? (
            <Text
              className="text-text mt-4"
              style={{ fontSize: 28, fontWeight: '700', letterSpacing: -0.4, lineHeight: 34 }}
            >
              {headline}
            </Text>
          ) : null}
          {sub ? (
            <Text className="text-text-muted mt-2" style={{ fontSize: 15, lineHeight: 22 }}>
              {sub}
            </Text>
          ) : null}
          <View className={cn(headline || sub ? 'mt-6' : 'mt-2', !scroll && 'flex-1')}>
            {children}
          </View>
        </Body>

        {footer ? (
          <View
            className="border-hairline bg-bg border-t px-6 pt-3"
            style={{ paddingBottom: Math.max(16, insets.bottom) }}
          >
            {footer}
          </View>
        ) : null}
      </View>
    </>
  );
}

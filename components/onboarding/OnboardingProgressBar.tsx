import { View } from '@/tw';
import { useThemeColors } from '@/tw/theme';

type Props = {
  /** 1-based step number among visible-progress screens (2-11). Pass 0 to hide. */
  step: number;
  /** Total number of progress-visible screens. */
  total?: number;
};

// Thin progress bar shown under the safe-area top inset on screens 2-11.
// Spec: 2px tall, accent fill on surface track.
export function OnboardingProgressBar({ step, total = 10 }: Props) {
  const colors = useThemeColors();
  if (step <= 0) return null;
  const pct = Math.min(1, Math.max(0, step / total));
  return (
    <View
      className="h-[2px] w-full"
      style={{ backgroundColor: colors.hairline }}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: step }}
    >
      <View
        style={{ width: `${pct * 100}%`, height: '100%', backgroundColor: colors.accent }}
      />
    </View>
  );
}

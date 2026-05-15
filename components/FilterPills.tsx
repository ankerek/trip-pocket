import { Pressable, ScrollView, Text } from '@/tw';
import { cn } from '@/tw/cn';

export type FilterOption = {
  id: string;
  label: string;
  count?: number;
};

type FilterPillsProps = {
  options: readonly FilterOption[];
  selectedId: string;
  onSelect: (id: string) => void;
};

/**
 * Horizontal scrollable trip filter row. Spec §4.1.
 * Active pill uses the accent token (teal) so it pops on both light and
 * dark surfaces. Inactive pill uses the hairline tint, which auto-flips
 * between dark-on-light and light-on-dark via the CSS variable.
 */
export function FilterPills({ options, selectedId, onSelect }: FilterPillsProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="px-3.5 py-2 gap-2"
    >
      {options.map((opt) => {
        const active = opt.id === selectedId;
        return (
          <Pressable
            key={opt.id}
            onPress={() => onSelect(opt.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={opt.label}
            className={cn(
              'flex-row items-center gap-1.5 rounded-full px-3 py-1.5',
              active ? 'bg-accent' : 'bg-hairline',
            )}
          >
            <Text
              className={cn('text-[13px]', active ? 'text-white' : 'text-text-muted')}
              style={{
                // Constant weight prevents the pill from changing width
                // when toggling active — bolder glyphs measure wider and
                // would shift neighboring pills horizontally.
                fontWeight: '600',
              }}
            >
              {opt.label}
            </Text>
            {opt.count !== undefined ? (
              <Text
                className={cn('text-[11px]', active ? 'text-white/70' : 'text-text-muted')}
                style={{ fontVariant: ['tabular-nums'] }}
              >
                {opt.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

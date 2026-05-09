import { Pressable, ScrollView, Text } from '@/tw';

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
 * Active pill = Sea bg + Snow text; inactive = Snow surface + slate text.
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
            className="flex-row items-center gap-1.5 rounded-full px-3 py-1.5"
            style={{
              backgroundColor: active ? '#0c4a6e' : 'rgba(15,23,42,0.06)',
            }}
          >
            <Text
              className="text-[13px]"
              style={{
                // Constant weight prevents the pill from changing width
                // when toggling active — bolder glyphs measure wider and
                // would shift neighboring pills horizontally.
                fontWeight: '600',
                color: active ? '#f8fafc' : '#475569',
              }}
            >
              {opt.label}
            </Text>
            {opt.count !== undefined ? (
              <Text
                className="text-[11px]"
                style={{
                  fontVariant: ['tabular-nums'],
                  color: active ? 'rgba(248,250,252,0.7)' : '#94a3b8',
                }}
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

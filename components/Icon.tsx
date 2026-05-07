import { Image } from '@/tw';

type IconProps = {
  name: string;
  size?: number;
  tintColor?: string;
  className?: string;
};

// SF Symbol via expo-image's `sf:` source. Pass the symbol name without the
// `sf:` prefix (e.g. `magnifyingglass`, `plus`, `ellipsis`).
export function Icon({ name, size = 22, tintColor, className }: IconProps) {
  return (
    <Image
      source={`sf:${name}`}
      style={{ width: size, height: size }}
      tintColor={tintColor}
      className={className}
    />
  );
}

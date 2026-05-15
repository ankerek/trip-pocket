import { ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { useLiveQuery } from '@/modules/storage';
import { PlaceRow, type PlaceRowData } from '@/components/PlaceRow';
import { openLapsePaywall } from '@/lib/paywall/openLapsePaywall';

const PLACES_SQL = `SELECT p.id, p.name, p.city, p.category,
                           ps.extracted_address AS address,
                           p.external_place_id, p.enrichment_status,
                           p.formatted_address, p.latitude, p.longitude,
                           p.photo_name, p.description, p.rating,
                           p.price_level, p.external_url
                      FROM place_sources ps
                      JOIN places p ON p.id = ps.place_id
                     WHERE ps.source_id = ?
                  ORDER BY ps.extracted_at ASC`;

const STATUS_SQL = `SELECT extraction_status, extraction_paused_reason, url_fetch_paused_reason
                      FROM sources WHERE id = ?`;

type StatusRow = {
  extraction_status: 'pending' | 'done' | 'failed';
  extraction_paused_reason: string | null;
  url_fetch_paused_reason: string | null;
};

export default function PlacesFoundSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const places = useLiveQuery<PlaceRowData>(PLACES_SQL, id ? [id] : [], [
    'place_sources',
    'places',
  ]);
  const statusRows = useLiveQuery<StatusRow>(STATUS_SQL, id ? [id] : [], ['sources']);

  if (places === null || statusRows === null) return null;
  const status = statusRows[0];

  if (
    status?.extraction_paused_reason === 'entitlement' ||
    status?.url_fetch_paused_reason === 'entitlement'
  ) {
    return <PausedEntitlementHint onResume={() => openLapsePaywall(router, pathname)} />;
  }
  if (status?.extraction_status === 'pending') {
    return <CenteredHint text="Still processing — places will appear in a few seconds." />;
  }
  if (status?.extraction_status === 'failed') {
    return (
      <CenteredHint text="Couldn't extract places this time. We'll retry on the next app launch." />
    );
  }
  if (places.length === 0) {
    return <CenteredHint text="No places detected." />;
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="bg-bg flex-1"
      contentContainerClassName="py-2"
    >
      {places.map((p) => (
        <PlaceRow key={p.id} place={p} />
      ))}
    </ScrollView>
  );
}

function CenteredHint({ text }: { text: string }) {
  return (
    <View className="bg-bg flex-1 items-center justify-center px-8">
      <Text className="text-text-muted text-center text-base">{text}</Text>
    </View>
  );
}

function PausedEntitlementHint({ onResume }: { onResume: () => void }) {
  return (
    <View className="bg-bg flex-1 items-center justify-center px-8" style={{ gap: 16 }}>
      <Text className="text-text text-center text-lg font-semibold">
        Paused — subscription required
      </Text>
      <Text className="text-text-muted text-center text-sm">
        Resume your subscription to continue processing this source.
      </Text>
      <Pressable
        onPress={onResume}
        accessibilityRole="button"
        accessibilityLabel="Resume subscription"
        className="bg-warning-bg rounded-full px-5 py-2"
      >
        <Text className="text-warning-text text-[14px] font-semibold">Resume</Text>
      </Pressable>
    </View>
  );
}

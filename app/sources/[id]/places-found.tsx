import { ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams } from 'expo-router';
import { useLiveQuery } from '@/modules/storage';
import { PlaceRow, type PlaceRowData } from '@/components/PlaceRow';

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

const STATUS_SQL = `SELECT extraction_status FROM sources WHERE id = ?`;

type StatusRow = { extraction_status: 'pending' | 'done' | 'failed' };

export default function PlacesFoundSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const places = useLiveQuery<PlaceRowData>(
    PLACES_SQL,
    id ? [id] : [],
    ['place_sources', 'places'],
  );
  const statusRows = useLiveQuery<StatusRow>(
    STATUS_SQL,
    id ? [id] : [],
    ['sources'],
  );

  if (places === null || statusRows === null) return null;
  const status = statusRows[0]?.extraction_status;

  if (status === 'pending') {
    return <CenteredHint text="Still processing — places will appear in a few seconds." />;
  }
  if (status === 'failed') {
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
      className="flex-1 bg-white"
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
    <View className="flex-1 items-center justify-center bg-white px-8">
      <Text className="text-center text-base text-slate-500">{text}</Text>
    </View>
  );
}

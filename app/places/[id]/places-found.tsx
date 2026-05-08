import { ScrollView, Text, View } from '@/tw';
import { useLocalSearchParams } from 'expo-router';
import { useLiveQuery } from '@/modules/storage';
import { PlaceRow, type PlaceRowData } from '@/components/PlaceRow';

const PLACES_SQL = `SELECT ep.id, ep.name, ep.city, ep.address, ep.category,
                           ep.external_place_id, ep.enrichment_status,
                           pe.formatted_address, pe.latitude, pe.longitude,
                           pe.photo_name, pe.description, pe.rating,
                           pe.price_level, pe.external_url
                      FROM extracted_places ep
                 LEFT JOIN place_enrichments pe
                           ON pe.external_place_id = ep.external_place_id
                     WHERE ep.screenshot_id = ? AND ep.deleted_at IS NULL
                  ORDER BY ep.created_at ASC`;

const STATUS_SQL = `SELECT extraction_status FROM screenshots
                     WHERE id = ? AND deleted_at IS NULL`;

type StatusRow = { extraction_status: 'pending' | 'done' | 'failed' };

export default function PlacesFoundSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const places = useLiveQuery<PlaceRowData>(
    PLACES_SQL,
    id ? [id] : [],
    ['extracted_places'],
  );
  const statusRows = useLiveQuery<StatusRow>(
    STATUS_SQL,
    id ? [id] : [],
    ['screenshots'],
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

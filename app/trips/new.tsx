import { useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { Pressable, Text, TextInput, View } from '@/tw';
import { Stack, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { createTrip } from '@/modules/storage';
import { useDatabase } from '@/components/useDatabase';
import { getOrCreateOwnerId } from '@/modules/capture';

export default function NewTrip() {
  const router = useRouter();
  const db = useDatabase();
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && db !== null;

  const onSave = async () => {
    if (!db || !canSave) return;
    try {
      await createTrip(db, {
        id: Crypto.randomUUID(),
        name: trimmed,
        ownerId: getOrCreateOwnerId(),
      });
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      router.back();
    } catch (err) {
      Alert.alert('Could not create trip', String(err));
    }
  };

  // ScrollView with contentInsetAdjustmentBehavior="automatic" tells iOS to
  // pad the body for the transparent/blurred header registered on this
  // route. Without it the form lands UNDER the header.
  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              className="px-3"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              hitSlop={8}
            >
              <Text style={{ fontSize: 16, color: '#475569' }}>Cancel</Text>
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              onPress={onSave}
              disabled={!canSave}
              className="px-3"
              accessibilityRole="button"
              accessibilityLabel="Save"
              accessibilityState={{ disabled: !canSave }}
              hitSlop={8}
            >
              <Text
                style={{
                  fontSize: 16,
                  fontWeight: '600',
                  color: canSave ? '#14b8a6' : '#cbd5e1',
                }}
              >
                Save
              </Text>
            </Pressable>
          ),
        }}
      />
      <ScrollView
        className="flex-1 bg-bg"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingTop: 24 }}
      >
        <Text
          className="text-text-muted mb-2"
          style={{ fontSize: 12, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase' }}
        >
          Trip name
        </Text>
        <TextInput
          autoFocus
          value={name}
          onChangeText={setName}
          placeholder="e.g. Japan"
          placeholderTextColor="#94a3b8"
          returnKeyType="done"
          onSubmitEditing={onSave}
          style={{
            fontSize: 17,
            color: '#0c4a6e',
            paddingHorizontal: 14,
            paddingVertical: 12,
            borderRadius: 12,
            backgroundColor: '#f8fafc',
            borderWidth: 1,
            borderColor: 'rgba(15,23,42,0.06)',
          }}
        />
      </ScrollView>
    </>
  );
}

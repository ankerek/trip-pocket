import { useState } from 'react';
import { Alert } from 'react-native';
import { Pressable, SafeAreaView, Text, TextInput, View } from '@/tw';
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

  return (
    <SafeAreaView className="flex-1 bg-white">
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Pressable
              onPress={() => router.back()}
              className="px-3"
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text className="text-base text-slate-600">Cancel</Text>
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
            >
              <Text
                className={
                  canSave
                    ? 'text-base font-semibold text-blue-600'
                    : 'text-base font-semibold text-slate-300'
                }
              >
                Save
              </Text>
            </Pressable>
          ),
        }}
      />
      <View className="p-4">
        <TextInput
          autoFocus
          value={name}
          onChangeText={setName}
          placeholder="Trip name (e.g. Japan)"
          className="rounded-md border border-slate-200 px-3 py-3 text-base"
          returnKeyType="done"
          onSubmitEditing={onSave}
        />
      </View>
    </SafeAreaView>
  );
}

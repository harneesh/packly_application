import { Redirect, Stack } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';

import { useAuthStore } from '@/store/auth-store';

export default function AuthLayout() {
  const { user, isLoading } = useAuthStore();

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#208AEF" />
      </View>
    );
  }

  if (user) {
    return <Redirect href="/" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

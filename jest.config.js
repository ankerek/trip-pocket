module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleDirectories: ['node_modules', 'node_modules/expo/node_modules'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^expo-sqlite$': '<rootDir>/__mocks__/expo-sqlite.ts',
    '^expo-crypto$': '<rootDir>/__mocks__/expo-crypto.ts',
    '^expo-application$': '<rootDir>/__mocks__/expo-application.ts',
    '^@sentry/react-native$': '<rootDir>/__mocks__/sentry-react-native.ts',
    '^react-native-purchases$': '<rootDir>/__mocks__/react-native-purchases.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native|expo[^/]*|@expo|@expo/.*|nativewind|react-native-css-interop|uuid)/)',
  ],
};

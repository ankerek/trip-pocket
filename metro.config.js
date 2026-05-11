const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const { withNativewind } = require('nativewind/metro');

// getSentryExpoConfig wraps expo/metro-config and adds the Sentry serializer
// that injects __sentry_debug_id__ into every JS module pre-Hermes. Without
// this, the source map gets uploaded with a debug id that nothing in the
// shipped bundle claims, so events arrive with un-symbolicated Hermes frames.
/** @type {import('expo/metro-config').MetroConfig} */
const config = getSentryExpoConfig(__dirname);

module.exports = withNativewind(config, {
  // inline variables break PlatformColor in CSS variables
  inlineVariables: false,
  // We add className support manually via tw/ wrappers
  globalClassNamePolyfill: false,
});

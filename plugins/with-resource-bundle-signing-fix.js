const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Xcode 14+ signs resource bundles by default; pod-vendored bundles (fonts,
// asset catalogs, etc.) have no development team, so the build fails.
// Older Expo Podfile templates injected this loop inside post_install; SDK 55's
// template does not, so we patch it back in here.
const SIGNING_FIX = `    installer.pods_project.targets.each do |target|
      if target.respond_to?(:product_type) && target.product_type == 'com.apple.product-type.bundle'
        target.build_configurations.each do |config|
          config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'
        end
      end
    end
`;

module.exports = function withResourceBundleSigningFix(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      if (contents.includes("config.build_settings['CODE_SIGNING_ALLOWED'] = 'NO'")) {
        return cfg;
      }

      const start = contents.indexOf('  post_install do |installer|');
      if (start < 0) {
        throw new Error('with-resource-bundle-signing-fix: post_install block not found');
      }
      const endIdx = contents.indexOf('\n  end', start);
      if (endIdx < 0) {
        throw new Error('with-resource-bundle-signing-fix: end of post_install not found');
      }

      contents = contents.slice(0, endIdx) + '\n' + SIGNING_FIX + contents.slice(endIdx);
      fs.writeFileSync(podfilePath, contents);
      return cfg;
    },
  ]);
};

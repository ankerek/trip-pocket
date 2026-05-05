const { withXcodeProject } = require('@expo/config-plugins');
const path = require('path');
const fs = require('fs');

const TARGET_NAME = 'TripPocketShare';
const SOURCE_DIR = path.resolve(__dirname, '..', 'native', 'ShareExtension');

const withShareExtension = (config) => withExtensionTarget(config);

function withExtensionTarget(config) {
  return withXcodeProject(config, async (cfg) => {
    const project = cfg.modResults;
    const platformProjectRoot = cfg.modRequest.platformProjectRoot;

    const targetDir = path.join(platformProjectRoot, TARGET_NAME);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const file of fs.readdirSync(SOURCE_DIR)) {
      fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(targetDir, file));
    }

    if (project.pbxTargetByName(TARGET_NAME)) return cfg;

    const target = project.addTarget(TARGET_NAME, 'app_extension', TARGET_NAME);

    // Source paths are prefixed with the target directory so the resulting
    // PBXFileReference resolves to ios/TripPocketShare/<file> rather than ios/<file>.
    // (sourceTree defaults to '<group>'; with no parent group, Xcode resolves
    // relative to the project main group, i.e. the ios/ root.)
    project.addBuildPhase(
      [
        `${TARGET_NAME}/ShareViewController.swift`,
        `${TARGET_NAME}/SaveButtonView.swift`,
        `${TARGET_NAME}/PendingImportWriter.swift`,
      ],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid,
    );
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    // No explicit Frameworks entry: `import SQLite3` in Swift triggers the system
    // SQLite3 clang module, which auto-links libsqlite3 via its module map.
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);

    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key in configurations) {
      const buildSettings = configurations[key].buildSettings;
      if (!buildSettings) continue;
      if (buildSettings.PRODUCT_NAME && buildSettings.PRODUCT_NAME.includes(TARGET_NAME)) {
        buildSettings.CODE_SIGN_ENTITLEMENTS = `${TARGET_NAME}/TripPocketShare.entitlements`;
        buildSettings.INFOPLIST_FILE = `${TARGET_NAME}/Info.plist`;
        buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `${cfg.ios.bundleIdentifier}.share`;
        buildSettings.IPHONEOS_DEPLOYMENT_TARGET = '15.1';
        buildSettings.SWIFT_VERSION = '5.0';
        buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
      }
    }

    return cfg;
  });
}

module.exports = withShareExtension;

const { withDangerousMod, withAppDelegate, withXcodeProject } = require('expo/config-plugins');
const path = require('path');
const fs = require('fs');

// Marker so re-runs don't double-inject the AppDelegate method.
const APPDELEGATE_MARKER = '// MARK: trip-pocket prewarm-session hook';

const TARGET_NAME = 'TripPocket';
const SOURCE_FILE_NAME = 'PrewarmSessionHolder.swift';
const SOURCE_PATH = path.resolve(__dirname, '..', 'native', 'MainApp', SOURCE_FILE_NAME);

/**
 * Wires the share-extension background URLSession completion handler into
 * the main app. Three things:
 *   1. Copies native/MainApp/PrewarmSessionHolder.swift into the prebuilt
 *      ios/TripPocket/ folder.
 *   2. Adds the file to the main app's Xcode target so it compiles.
 *   3. Injects `application:handleEventsForBackgroundURLSession:completionHandler:`
 *      into AppDelegate.swift so iOS can deliver background events back to
 *      the host app after the share extension dies.
 */
const withPrewarmSession = (config) => {
  config = withCopySwiftFile(config);
  config = withXcodeSource(config);
  config = withAppDelegateHook(config);
  return config;
};

function withCopySwiftFile(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const targetDir = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(SOURCE_PATH, path.join(targetDir, SOURCE_FILE_NAME));
      return cfg;
    },
  ]);
}

function withXcodeSource(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const groupKey = project.findPBXGroupKey({ name: TARGET_NAME });
    if (!groupKey) {
      console.warn(
        '[with-prewarm-session] PBXGroup ' +
          TARGET_NAME +
          ' not found; skipping source-file add.',
      );
      return cfg;
    }
    // Avoid re-adding on repeat invocations (the file ref persists across
    // prebuilds when the project file is cached).
    const existingRef = project.hasFile(SOURCE_FILE_NAME);
    if (existingRef) return cfg;
    project.addSourceFile(
      `${TARGET_NAME}/${SOURCE_FILE_NAME}`,
      { target: project.getFirstTarget().uuid },
      groupKey,
    );
    return cfg;
  });
}

function withAppDelegateHook(config) {
  return withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(APPDELEGATE_MARKER)) {
      return cfg; // Already injected.
    }
    // Inject the override just before the closing brace of the AppDelegate
    // class. We find the LAST "}" before `class ReactNativeDelegate` (the
    // sibling class in this file) and insert above it.
    const reactDelegateMarker = 'class ReactNativeDelegate';
    const reactDelegateIdx = src.indexOf(reactDelegateMarker);
    if (reactDelegateIdx === -1) {
      console.warn(
        '[with-prewarm-session] could not locate ReactNativeDelegate marker; skipping AppDelegate injection.',
      );
      return cfg;
    }
    const beforeReact = src.slice(0, reactDelegateIdx);
    const closingBraceIdx = beforeReact.lastIndexOf('}');
    if (closingBraceIdx === -1) {
      console.warn(
        '[with-prewarm-session] could not locate AppDelegate closing brace; skipping injection.',
      );
      return cfg;
    }
    const injection = `
  ${APPDELEGATE_MARKER}
  // Background URLSession events for the share-extension prewarm session.
  // Recreates the session by identifier WITH a delegate, retains it via
  // PrewarmSessionHolder, and invokes the system completion handler when
  // events finish — required so iOS keeps delivering background events.
  public override func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    PrewarmSessionHolder.shared.attach(identifier: identifier, completion: completionHandler)
  }

`;
    cfg.modResults.contents =
      src.slice(0, closingBraceIdx) + injection + src.slice(closingBraceIdx);
    return cfg;
  });
}

module.exports = withPrewarmSession;

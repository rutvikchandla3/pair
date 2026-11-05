"use strict";

// Expo derives the native project names from `name`, so the home-screen label is set separately.

const { AndroidConfig, withInfoPlist, withStringsXml } = require("expo/config-plugins");

module.exports = function withAppDisplayName(config, displayName) {
  const withIosName = withInfoPlist(config, (cfg) => {
    cfg.modResults.CFBundleDisplayName = displayName;
    return cfg;
  });
  return withStringsXml(withIosName, (cfg) => {
    cfg.modResults = AndroidConfig.Strings.setStringItem(
      [AndroidConfig.Resources.buildResourceItem({ name: "app_name", value: displayName })],
      cfg.modResults,
    );
    return cfg;
  });
};

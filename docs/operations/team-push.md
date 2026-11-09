# Team push notifications

A team server, and a Pair Cloud server from its first member, sends its members' push notifications
itself, through Expo's push service, instead of through T3 Connect. Expo only delivers to apps built
in the EAS project that issued the device's push token. Pair publishes one app build under its own
store ids and EAS project, so any Pair server can push to it: members install Pair's app and pair it
with the server. Nobody builds their own. T3 Code's store app registers nothing with a team server.

Each push carries a short phrase ("Thread completed", "Assigned to you") and the thread's title, which
pass through Expo and Apple or Google. Messages, agent output and project names are never sent.

The server's machine needs outbound HTTPS to `exp.host`.

## Pair's app build

The `pair-production` build and submit profiles in `apps/mobile/eas.json` build Pair's app. Their
values are placeholders until the maintainers replace them with Pair's ids; a build fails on the
placeholder bundle id and package rather than signing under a wrong one.

1. A paid Apple Developer account. A personal team cannot sign the push entitlement.
2. An EAS project. Upload an APNs key for the bundle id to it, for example with `eas credentials`.
   Leave the project's push access-token requirement off: servers send no Expo access token.
3. A Firebase project with the Android package registered. Store its `google-services.json` as an EAS
   file variable named `T3CODE_ANDROID_GOOGLE_SERVICES_FILE` in the project's production environment,
   as in [Android notifications](./android-notifications.md#firebase-and-app-build), and upload its
   FCM V1 service-account key to the EAS project. Keep it out of the profile's `env`, which would
   replace the file with a literal.
4. The profile's `env` sets the overrides below. `ascAppId` in the submit profile is Pair's App Store
   Connect app.

## Overrides

Each variable left unset keeps T3 Code's own value. A fork that publishes its own app sets them the
same way, during prebuild and build.

- `T3CODE_IOS_BUNDLE_ID`: an iOS bundle id registered to the Apple team. The keychain group follows
  it, and the push entitlement stays.
- `T3CODE_IOS_TEAM_ID`: the Apple team id.
- `T3CODE_ANDROID_PACKAGE`: the Android package. With its own package, the app installs beside T3
  Code's instead of replacing it.
- `T3CODE_EAS_PROJECT_ID`: the EAS project. The app asks Expo for a push token for this project. It
  is also the OTA update source, so set `T3CODE_MOBILE_UPDATES_ENABLED=0` unless you publish updates
  there.
- `T3CODE_EAS_OWNER`: the EAS account that owns the project.

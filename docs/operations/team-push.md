# Team push notifications

A team server sends its members' push notifications itself, through Expo's push service, instead of
through T3 Connect. Expo only delivers to apps built in the EAS project that issued the device's push
token, so each team needs its own mobile build. Until a member runs one, the app registers nothing and
the server sends nothing to them.

Each push carries a short phrase ("Thread completed", "Assigned to you") and the thread's title, which
pass through Expo and Apple or Google. Messages, agent output and project names are never sent.

## Setup

1. A paid Apple Developer account. A personal team cannot sign the push entitlement.
2. An EAS project. Upload an APNs key for your bundle id to it, for example with `eas credentials`.
   Leave the project's push access-token requirement off: the server sends no Expo access token.
3. A Firebase project with the Android package registered. Set `T3CODE_ANDROID_GOOGLE_SERVICES_FILE`
   to its `google-services.json`, as in [Android notifications](./android-notifications.md#firebase-and-app-build),
   and upload its FCM V1 service-account key to the EAS project.
4. Build the app with these variables set during prebuild and build. Each one left unset keeps T3
   Code's own value.
   - `T3CODE_IOS_BUNDLE_ID`: an iOS bundle id registered to your Apple team. The keychain group
     follows it, and the push entitlement stays.
   - `T3CODE_IOS_TEAM_ID`: your Apple team id.
   - `T3CODE_EAS_PROJECT_ID`: your EAS project. The app asks Expo for a push token for this project.
     It is also the OTA update source, so set `T3CODE_MOBILE_UPDATES_ENABLED=0` unless you publish
     updates there.
   - `T3CODE_EAS_OWNER`: the EAS account that owns the project.
5. Allow outbound HTTPS from the server's machine to `exp.host`.

The Android package id is not overridable, so a team's Android build replaces the store app on a
phone rather than installing beside it.

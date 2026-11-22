import {
  SPACE_PAIR_OFF_REASON,
  type SpaceMentionToken,
  type SpaceViewer,
  insertSpaceMention,
  resolveSpaceMentions,
  spaceAskAdmin,
  spaceComposerHint,
  spacePairOffHint,
  spaceMentionCandidates,
  spaceMentionQuery,
  spacePostPreview,
} from "@t3tools/client-runtime/spaces";
import {
  type ChatFileAttachment,
  type ChatImageAttachment,
  type EnvironmentId,
  MessageId,
  SPACE_POST_MAX_ATTACHMENTS,
  SPACE_QUOTE_MAX_LENGTH,
  type Space,
  type SpaceRoomEntry,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { TextInputWrapper } from "expo-paste-input";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { MemberAvatar } from "../../components/MemberAvatar";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import {
  prepareTurnAttachments,
  releasePendingAttachmentUploads,
} from "../../lib/attachmentUpload";
import { cn } from "../../lib/cn";
import {
  type DraftComposerAttachment,
  convertPastedImagesToAttachments,
  pickComposerFiles,
  pickComposerImages,
} from "../../lib/composerImages";
import { useNativePaste } from "../../lib/useNativePaste";
import { useServerConfigs } from "../../state/entities";
import { uuidv4 } from "../../lib/uuid";
import {
  reportSpaceResult,
  spaceEnvironment,
  useCanManageTeamClaudeKey,
  useTeamClaudeKeyStatus,
} from "../../state/spaces";
import { useTeamRoster } from "../../state/team";
import { releaseUnusedComposerAttachmentFiles } from "../../state/use-composer-drafts";
import { useAtomCommand } from "../../state/use-atom-command";
import { openSettings } from "../settings/settings-navigation";

export type SpacePost = Extract<SpaceRoomEntry, { type: "post" }>;

export function SpaceComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly space: Space;
  readonly viewer: SpaceViewer;
  readonly quote: SpacePost | null;
  readonly onQuoteChange: (quote: SpacePost | null) => void;
  readonly bottomInset: number;
  /** "Ask again" fills it; the room remounts the composer with each new draft. */
  readonly initialText?: string;
}) {
  const navigation = useNavigation();
  const { members } = useTeamRoster(props.environmentId);
  const keyStatus = useTeamClaudeKeyStatus(props.environmentId);
  const canManageKey = useCanManageTeamClaudeKey(props.environmentId);
  const pairOff = spacePairOffHint(
    keyStatus,
    canManageKey,
    spaceAskAdmin(props.space, members.values(), keyStatus),
  );
  const [drafted, setDrafted] = useState(false);
  const post = useAtomCommand(spaceEnvironment.post, { reportFailure: false });
  const [text, setText] = useState(props.initialText ?? "");
  // The draft as typed, read after a failed send to tell whether a new one was started.
  const textRef = useRef(props.initialText ?? "");
  const [caret, setCaret] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>();
  const [tokens, setTokens] = useState<ReadonlyArray<SpaceMentionToken>>([]);
  const [attachments, setAttachments] = useState<ReadonlyArray<DraftComposerAttachment>>([]);
  const capabilities = useServerConfigs().get(props.environmentId)?.environment.capabilities;
  const [sending, setSending] = useState(false);
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const query = spaceMentionQuery(text, Math.min(caret, text.length));
  const candidates =
    query === null ? [] : spaceMentionCandidates(query.query, props.space, props.viewer);
  const mentions = resolveSpaceMentions(text, tokens);
  const hint = spaceComposerHint(mentions, props.viewer);
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending;
  const full = attachments.length >= SPACE_POST_MAX_ATTACHMENTS;

  const addAttachments = (added: ReadonlyArray<DraftComposerAttachment>) => {
    const room = Math.max(0, SPACE_POST_MAX_ATTACHMENTS - attachments.length);
    if (added.length > room) {
      Dialog.alert(
        "Too many attachments",
        `A message holds up to ${SPACE_POST_MAX_ATTACHMENTS} attachments.`,
      );
      void releaseUnusedComposerAttachmentFiles(added.slice(room));
    }
    if (room > 0 && added.length > 0) setAttachments([...attachments, ...added.slice(0, room)]);
  };

  const pickImages = async () => {
    const result = await pickComposerImages({ existingCount: attachments.length });
    addAttachments(result.images);
    if (result.error !== null) Dialog.alert("Could not add images", result.error);
  };

  const pickFiles = async () => {
    const result = await pickComposerFiles({
      existingCount: attachments.length,
      ...(capabilities?.fileAttachments?.maxUploadBytes === undefined
        ? {}
        : { maxBytes: capabilities.fileAttachments.maxUploadBytes }),
    });
    addAttachments(result.files);
    if (result.error !== null) Dialog.alert("Could not add files", result.error);
  };

  const removeAttachment = (id: string) => {
    const removed = attachments.filter((attachment) => attachment.id === id);
    setAttachments(attachments.filter((attachment) => attachment.id !== id));
    void releaseUnusedComposerAttachmentFiles(removed);
  };

  const onPaste = useNativePaste((uris) => {
    void convertPastedImagesToAttachments({ uris, existingCount: attachments.length })
      .then(addAttachments)
      .catch(() => Dialog.alert("Could not paste", "The image could not be read."));
  });

  const choose = (token: SpaceMentionToken) => {
    if (query === null) return;
    if (token.mention.type === "pair" && pairOff !== null) return;
    const next = insertSpaceMention(text, query, token);
    textRef.current = next.text;
    setText(next.text);
    setSelection({ start: next.caret, end: next.caret });
    setCaret(next.caret);
    setTokens([...tokens, token]);
  };

  const send = async () => {
    const sentAttachments = attachments;
    if (text.trim().length === 0 && sentAttachments.length === 0) return;
    const quote = props.quote;
    const sentTokens = tokens;
    let uploaded: ReadonlyArray<ChatImageAttachment | ChatFileAttachment> = [];
    let pending: ReadonlyArray<string> = [];
    if (sentAttachments.length > 0) {
      setSending(true);
      const prepared = await prepareTurnAttachments({
        environmentId: props.environmentId,
        attachments: sentAttachments,
        supportsImageUploads: true,
      }).catch((error: unknown) => {
        Dialog.alert(
          "Could not upload attachments",
          error instanceof Error && error.message.trim() !== "" ? error.message : "Try again.",
        );
        return null;
      });
      setSending(false);
      if (prepared === null || prepared.status !== "ready") return;
      uploaded = prepared.attachments.filter(
        (attachment): attachment is ChatImageAttachment | ChatFileAttachment =>
          !("dataUrl" in attachment),
      );
      pending = prepared.pendingAttachmentIds;
    }
    // Read after the upload: the input stays editable while it runs.
    const body = textRef.current.trim();
    const sentMentions = resolveSpaceMentions(textRef.current, sentTokens);
    textRef.current = "";
    setText("");
    setCaret(0);
    setTokens([]);
    setAttachments([]);
    setDrafted(false);
    props.onQuoteChange(null);
    const result = await post({
      environmentId: props.environmentId,
      input: {
        spaceId: props.space.id,
        messageId: MessageId.make(uuidv4()),
        text: body,
        mentions: sentMentions,
        ...(quote === null ? {} : { quoteEntryId: quote.id }),
        ...(uploaded.length === 0 ? {} : { attachments: uploaded }),
      },
    });
    // The post holds its own copies; the pending uploads are only the source.
    if (pending.length > 0)
      void releasePendingAttachmentUploads(props.environmentId, pending).catch(() => {});
    // Hand the draft back, mentions, attachments and quote too, unless a new one was started.
    const posted = reportSpaceResult("Could not post", result);
    if (!posted && textRef.current === "") {
      textRef.current = body;
      setText(body);
      setCaret(body.length);
      setTokens(sentTokens);
      setAttachments((current) => (current.length === 0 ? sentAttachments : current));
      if (quote !== null) props.onQuoteChange(quote);
    } else if (posted) {
      void releaseUnusedComposerAttachmentFiles(sentAttachments);
    }
  };

  return (
    <View
      className="border-t border-border-subtle bg-screen px-3 pt-2"
      style={{ paddingBottom: Math.max(props.bottomInset, 8) }}
    >
      {candidates.length > 0 ? (
        <View
          accessibilityLabel="Mention"
          className="mb-2 overflow-hidden rounded-2xl border border-border-subtle bg-card"
        >
          {candidates.map((token) => {
            const member =
              token.mention.type === "member" ? members.get(token.mention.memberId) : undefined;
            const off = token.mention.type === "pair" && pairOff !== null;
            return (
              <Pressable
                key={token.mention.type === "pair" ? "pair" : token.mention.memberId}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${token.label}`}
                accessibilityState={{ disabled: off }}
                disabled={off}
                onPress={() => choose(token)}
                className={cn(
                  "min-h-11 flex-row items-center gap-3 px-3 active:opacity-70",
                  off && "opacity-50",
                )}
              >
                {token.mention.type === "pair" ? (
                  <SymbolView name="sparkles" size={18} tintColorClassName="accent-icon" />
                ) : (
                  <MemberAvatar
                    member={{ name: token.label, color: member?.color ?? "#71717a" }}
                    size="md"
                  />
                )}
                <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
                  {token.label}
                </Text>
                {token.mention.type === "pair" ? (
                  <Text className="text-xs text-foreground-muted">
                    {off ? SPACE_PAIR_OFF_REASON : "agent"}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {props.quote === null ? null : (
        <View className="mb-2 flex-row items-center gap-2 rounded-xl bg-subtle py-1 pr-1 pl-3">
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-xs font-t3-medium text-foreground">
              Replying to {props.viewer.nameOf(props.quote.authorId)}
            </Text>
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              {spacePostPreview(props.quote).slice(0, SPACE_QUOTE_MAX_LENGTH)}
            </Text>
          </View>
          <IconButton
            icon="xmark"
            accessibilityLabel="Cancel reply"
            onPress={() => props.onQuoteChange(null)}
          />
        </View>
      )}
      {attachments.length === 0 ? null : (
        <View className="pb-2">
          <ComposerAttachmentStrip
            attachments={attachments}
            imageSize={60}
            imageBorderRadius={14}
            removeButtonPlacement="gutter"
            onPressPreview={setPreviewFile}
            onRemove={removeAttachment}
          />
        </View>
      )}
      <View className="flex-row items-end gap-2">
        <IconButton
          icon="photo"
          accessibilityLabel="Add images"
          disabled={full || sending}
          onPress={() => void pickImages()}
        />
        {capabilities?.fileAttachments === undefined ? null : (
          <IconButton
            icon="doc.text"
            accessibilityLabel="Attach files"
            disabled={full || sending}
            onPress={() => void pickFiles()}
          />
        )}
        <TextInputWrapper onPaste={onPaste} style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            accessibilityLabel="Message the space"
            multiline
            placeholder="Message · @ to mention"
            placeholderTextColorClassName="accent-foreground-muted"
            value={text}
            selection={selection}
            onChangeText={(next) => {
              textRef.current = next;
              setText(next);
              setSelection(undefined);
            }}
            onSelectionChange={(event) => setCaret(event.nativeEvent.selection.end)}
            className="max-h-36 min-h-11 min-w-0 flex-1 rounded-[22px] border border-border-subtle bg-card px-4 py-2.5 text-base text-foreground"
          />
        </TextInputWrapper>
        <IconButton
          icon="arrow.up"
          variant="primary"
          accessibilityLabel="Send"
          disabled={!canSend}
          onPress={() => void send()}
        />
      </View>
      {hint === null ? null : (
        <Text numberOfLines={1} className="px-2 pt-1 text-xs text-foreground-muted">
          {hint}
        </Text>
      )}
      {pairOff === null ? null : (
        <View className="flex-row items-center gap-2 px-2 pt-1">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
            {drafted ? "Request drafted" : pairOff.text}
          </Text>
          {pairOff.action?.type === "add-key" ? (
            <HintLink label="Add key" onPress={() => openSettings(navigation, "SettingsTeam")} />
          ) : pairOff.action?.type === "ask" && !drafted ? (
            <HintLink
              label={pairOff.action.ask.label}
              onPress={() => {
                if (pairOff.action?.type !== "ask") return;
                const { draft } = pairOff.action.ask;
                textRef.current = draft.text;
                setText(draft.text);
                setCaret(draft.text.length);
                setSelection({ start: draft.text.length, end: draft.text.length });
                setTokens(draft.tokens);
                setDrafted(true);
              }}
            />
          ) : null}
        </View>
      )}
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
    </View>
  );
}

function HintLink(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="min-h-8 justify-center active:opacity-70"
    >
      <Text className="text-xs font-t3-medium text-primary-text">{props.label}</Text>
    </Pressable>
  );
}

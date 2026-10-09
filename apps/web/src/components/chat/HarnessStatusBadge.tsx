import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, HarnessRoles, ThreadId } from "@t3tools/contracts";
import { memo, useId, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { Badge } from "../ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

type BadgeStatus = "on" | "off" | "unknown";

interface BadgePresentation {
  readonly status: BadgeStatus;
  readonly reason: string;
  readonly model: string | null;
  readonly evaluatedAt: string | null;
  readonly roles: HarnessRoles;
}

const NO_ROLES: HarnessRoles = { orchestrator: null, implementer: null, reviewer: null };

const STATUS_TEXT: Record<BadgeStatus, string> = {
  on: "Harness ON · 統括",
  off: "Harness OFF",
  unknown: "Harness 未確認",
};

const STATUS_VARIANT = {
  on: "success",
  off: "outline",
  unknown: "warning",
} as const;

// Hook decision codes and server/client codes for why the status is unknown. An
// unlisted code is shown as-is.
const REASON_TEXT: Readonly<Record<string, string>> = {
  orchestrator_model: "統括モデルのためハーネスが有効",
  non_orchestrator_model: "統括モデルではないため無効",
  child_role: "子ロールのため無効",
  native_child: "ネイティブ子エージェントのため無効",
  wiki: "wiki 配下のため無効",
  missing_model: "モデルが不明",
  configuration_error: "ハーネス設定を読み込めない",
  thread_not_found: "スレッドが見つからない",
  no_provider_thread: "プロバイダースレッドがない",
  unsupported_provider: "Codex 以外のため未対応",
  provider_thread_mismatch: "プロバイダースレッドが一致しない",
  no_native_session: "ネイティブセッションがない",
  state_missing: "フックの状態がまだ書かれていない",
  state_invalid: "フックの状態を読み取れない",
  state_session_mismatch: "フックの状態が別セッションのもの",
  state_model_mismatch: "フックの状態が現在のモデルと異なる",
  awaiting_hook_after_model_change: "モデル変更後のフック実行待ち",
  awaiting_hook_after_run_start: "実行開始後のフック実行待ち",
  draft: "下書きのため未確認",
  disconnected: "接続されていないため未確認",
  loading: "状態を取得中",
  request_failed: "状態の取得に失敗",
  thread_mismatch: "別スレッドの応答のため破棄",
  model_mismatch: "現在のモデルと異なる応答のため破棄",
};

function describeReason(reason: string): string {
  const description = REASON_TEXT[reason];
  return description === undefined ? reason : `${description} (${reason})`;
}

function unknownPresentation(reason: string, model: string | null): BadgePresentation {
  return { status: "unknown", reason, model, evaluatedAt: null, roles: NO_ROLES };
}

function formatEvaluatedAt(value: string | null): string {
  if (value === null) return "未確認";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ja-JP");
}

function HarnessBadgeView({ presentation }: { readonly presentation: BadgePresentation }) {
  const { roles } = presentation;
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1.5">
      <Popover>
        <PopoverTrigger
          render={
            <Badge
              size="control"
              variant={STATUS_VARIANT[presentation.status]}
              render={<button type="button" aria-label="Harness status details" />}
            />
          }
        >
          {STATUS_TEXT[presentation.status]}
        </PopoverTrigger>
        <PopoverPopup width="sm" align="start">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">理由</dt>
            <dd>{describeReason(presentation.reason)}</dd>
            <dt className="text-muted-foreground">モデル</dt>
            <dd>{presentation.model ?? "未確認"}</dd>
            <dt className="text-muted-foreground">統括</dt>
            <dd>{roles.orchestrator ?? "未確認"}</dd>
            <dt className="text-muted-foreground">実装担当</dt>
            <dd>{roles.implementer ?? "未確認"}</dd>
            <dt className="text-muted-foreground">レビュー担当</dt>
            <dd>{roles.reviewer ?? "未確認"}</dd>
            <dt className="text-muted-foreground">確認時刻</dt>
            <dd>{formatEvaluatedAt(presentation.evaluatedAt)}</dd>
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">子エージェントの稼働状態は未確認</p>
        </PopoverPopup>
      </Popover>
      {presentation.model === null ? null : (
        <span className="max-w-32 truncate text-xs text-muted-foreground">
          {presentation.model}
        </span>
      )}
    </span>
  );
}

/**
 * Polls only while mounted. The parent keys this by environment, thread, connection
 * generation, model, provider instance and provider thread, and every instance asks
 * through its own query atom (`observerKey`), so a reply still in flight for an
 * earlier thread, connection or session selection can never reach a later instance.
 */
const PolledHarnessBadge = memo(function PolledHarnessBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly model: string | null;
}) {
  const observerKey = useId();
  const result = useAtomValue(
    orchestrationEnvironment.harnessStatus({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, observerKey },
    }),
  );
  let presentation: BadgePresentation;
  if (result._tag === "Failure") {
    // A failure keeps the previous success around; never display it.
    presentation = unknownPresentation("request_failed", props.model);
  } else if (result._tag !== "Success") {
    presentation = unknownPresentation("loading", props.model);
  } else if (result.value.threadId !== props.threadId) {
    presentation = unknownPresentation("thread_mismatch", props.model);
  } else if (props.model === null || result.value.model !== props.model) {
    presentation = unknownPresentation("model_mismatch", props.model);
  } else {
    presentation = {
      status: result.value.status,
      reason: result.value.reason,
      model: result.value.model,
      evaluatedAt: result.value.evaluatedAt,
      roles: result.value.roles,
    };
  }
  return <HarnessBadgeView presentation={presentation} />;
});

export const HarnessStatusBadge = memo(function HarnessStatusBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isServerThread: boolean;
}) {
  const { environmentId, threadId, isServerThread } = props;
  const threadRef = useMemo(
    () => (isServerThread ? scopeThreadRef(environmentId, threadId) : null),
    [environmentId, isServerThread, threadId],
  );
  const shell = useThreadShell(threadRef);
  const connectionResult = useAtomValue(environmentCatalog.stateAtom(environmentId));
  // Only a settled Success counts: a Failure keeps the last connected snapshot as
  // previousSuccess, which AsyncResult.value would hand back as if still live.
  const connection = connectionResult._tag === "Success" ? connectionResult.value : null;
  const model = shell?.modelSelection.model ?? null;
  const selectionKey = JSON.stringify([
    environmentId,
    threadId,
    connection?.generation ?? null,
    model,
    shell?.modelSelection.instanceId ?? null,
    shell?.session?.providerName ?? null,
    shell?.session?.providerInstanceId ?? null,
    shell?.session?.updatedAt ?? null,
    shell?.latestTurn?.turnId ?? null,
  ]);
  if (!isServerThread) {
    return <HarnessBadgeView presentation={unknownPresentation("draft", null)} />;
  }
  if (connection === null || connection.phase !== "connected") {
    return <HarnessBadgeView presentation={unknownPresentation("disconnected", model)} />;
  }
  return (
    <PolledHarnessBadge
      key={selectionKey}
      environmentId={environmentId}
      threadId={threadId}
      model={model}
    />
  );
});

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

HOOK = Path(__file__).with_name("harness_gate.py")
HARNESS_TEXT = "# Harness\nルーティング本文\n"
OPUS = "anthropic/claude-opus-5-5"
SONNET = "anthropic/claude-sonnet-5-5"


class HarnessGateTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name).resolve()
        agents = self.home / ".agents"
        agents.mkdir()
        (agents / "harness-orchestrators.txt").write_text("# comment\nclaude-opus-5-5\ngpt-6-astra\n", encoding="utf-8")
        (agents / "harness-agent.md").write_bytes(HARNESS_TEXT.encode("utf-8"))
        roles = self.home / ".codex" / "agents"
        roles.mkdir(parents=True)
        (roles / "implementer.toml").write_text('model = "impl-model"\n', encoding="utf-8")
        (roles / "reviewer.toml").write_text('model = "review-model"\n', encoding="utf-8")
        self.cwd = self.home / "work"
        self.cwd.mkdir()
        self.state_dir = agents / "state"

    def run_hook(self, session_id="s1", model=OPUS, event="SessionStart", cwd=None, env=None, **extra):
        payload = {"hook_event_name": event, "model": model, "cwd": str(cwd or self.cwd), **extra}
        if session_id is not None:
            payload["session_id"] = session_id
        environ = {k: v for k, v in os.environ.items() if k != "HARNESS_ROLE"}
        environ.update(HOME=str(self.home), USERPROFILE=str(self.home), **(env or {}))
        proc = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(payload).encode("utf-8"),
                              capture_output=True, env=environ, check=False)
        return (proc.returncode, proc.stdout.decode("utf-8").replace("\r\n", "\n"),
                proc.stderr.decode("utf-8", "replace"))

    def state_file(self, session_id):
        digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
        return self.state_dir / f"harness-status-{digest}.json"

    def state(self, session_id="s1"):
        return json.loads(self.state_file(session_id).read_text(encoding="utf-8"))

    def directory_alias(self, alias, target):
        self.assertTrue(alias.is_relative_to(self.home))
        self.assertTrue(target.is_relative_to(self.home))
        if os.name == "nt":
            import _winapi
            import ctypes
            from ctypes import wintypes

            remove_directory = ctypes.WinDLL("kernel32", use_last_error=True).RemoveDirectoryW
            remove_directory.argtypes = [wintypes.LPCWSTR]
            remove_directory.restype = wintypes.BOOL
            _winapi.CreateJunction(str(target), str(alias))

            def remove_alias():
                # RemoveDirectoryW removes only the junction, never its target contents.
                if not remove_directory(str(alias)):
                    raise ctypes.WinError(ctypes.get_last_error())
                self.assertTrue(target.is_dir())
        else:
            alias.symlink_to(target, target_is_directory=True)

            def remove_alias():
                os.remove(alias)
                self.assertTrue(target.is_dir())

        # Clean the alias before TemporaryDirectory cleanup can traverse the fixture.
        self.addCleanup(remove_alias)

    def test_orchestrator_model_is_on_and_injects_harness(self):
        code, out, err = self.run_hook()
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, f"HARNESS ACTIVE: this session's model {chr(96)}{OPUS}{chr(96)} is a harness orchestrator "
                              "(~/.agents/harness-orchestrators.txt). You are the orchestrator; follow the harness below.\n\n"
                              + HARNESS_TEXT + "\n")
        state = self.state()
        evaluated = state.pop("evaluatedAt")
        self.assertTrue(evaluated.endswith("Z"))
        datetime.fromisoformat(evaluated.replace("Z", "+00:00"))
        self.assertEqual(state, {
            "version": 1, "sessionId": "s1", "model": OPUS, "status": "on", "reason": "orchestrator_model",
            "cwd": str(self.cwd),
            "roles": {"orchestrator": OPUS, "implementer": "impl-model", "reviewer": "review-model"},
        })
        self.assertEqual([p.name for p in self.state_dir.iterdir()], [self.state_file("s1").name])

    def test_other_model_is_off_with_inactive_notice(self):
        code, out, _ = self.run_hook(model=SONNET)
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith(f"HARNESS INACTIVE: this session's model {chr(96)}{SONNET}{chr(96)} is not"))
        state = self.state()
        self.assertEqual((state["status"], state["reason"]), ("off", "non_orchestrator_model"))
        self.assertEqual(state["roles"], {"orchestrator": None, "implementer": "impl-model", "reviewer": "review-model"})

    def test_missing_model_is_unknown(self):
        _, _, _ = self.run_hook(model="")
        state = self.state()
        self.assertEqual((state["status"], state["reason"], state["model"]), ("unknown", "missing_model", ""))

    def test_wiki_uses_path_ancestry(self):
        wiki = self.home / "wiki" / "llm-wiki"
        sibling = self.home / "wiki" / "llm-wiki-other" / "child"
        (wiki / "sub").mkdir(parents=True)
        sibling.mkdir(parents=True)
        for index, cwd in enumerate((wiki, wiki / "sub")):
            _, out, _ = self.run_hook(session_id=f"w{index}", cwd=cwd)
            self.assertIn("librarian", out)
            self.assertEqual(self.state(f"w{index}")["reason"], "wiki")
            self.assertEqual(self.state(f"w{index}")["status"], "off")
        _, out, _ = self.run_hook(session_id="w0", event="UserPromptSubmit", cwd=wiki)
        self.assertEqual(out, "")
        _, out, _ = self.run_hook(session_id="sib", cwd=sibling)
        self.assertIn("HARNESS ACTIVE", out)
        self.assertEqual(self.state("sib")["status"], "on")

    def test_alias_into_wiki_is_off(self):
        wiki = self.home / "wiki" / "llm-wiki"
        (wiki / "sub").mkdir(parents=True)
        alias = self.home / "wiki-alias"
        self.directory_alias(alias, wiki)
        for index, cwd in enumerate((alias, alias / "sub")):
            with self.subTest(cwd=cwd):
                session_id = f"alias{index}"
                code, out, err = self.run_hook(session_id=session_id, cwd=cwd)
                self.assertEqual((code, err), (0, ""))
                self.assertIn("librarian", out)
                self.assertNotIn("HARNESS ACTIVE", out)
                state = self.state(session_id)
                self.assertEqual((state["status"], state["reason"]), ("off", "wiki"))

    def test_wiki_root_alias_is_resolved(self):
        target = self.home / "actual-wiki"
        (target / "sub").mkdir(parents=True)
        wiki = self.home / "wiki" / "llm-wiki"
        wiki.parent.mkdir()
        self.directory_alias(wiki, target)
        code, out, err = self.run_hook(cwd=target / "sub")
        self.assertEqual((code, err), (0, ""))
        self.assertIn("librarian", out)
        state = self.state()
        self.assertEqual((state["status"], state["reason"]), ("off", "wiki"))

    def test_child_role_is_off_and_silent(self):
        code, out, err = self.run_hook(env={"HARNESS_ROLE": "implementer"})
        self.assertEqual((code, out, err), (0, "", ""))
        state = self.state()
        self.assertEqual((state["status"], state["reason"], state["roles"]["orchestrator"]), ("off", "child_role", None))

    def test_native_child_is_off_and_silent(self):
        child = self.home / "child.jsonl"
        child.write_text(json.dumps({"payload": {"parent_thread_id": "p"}}) + "\n", encoding="utf-8")
        _, out, _ = self.run_hook(transcript_path=str(child))
        self.assertEqual(out, "")
        self.assertEqual(self.state()["reason"], "native_child")
        root = self.home / "root.jsonl"
        root.write_text(json.dumps({"payload": {"id": "x"}}) + "\n", encoding="utf-8")
        _, out, _ = self.run_hook(session_id="s2", transcript_path=str(root))
        self.assertIn("HARNESS ACTIVE", out)

    def test_unchanged_prompt_is_silent_but_refreshes_state(self):
        self.run_hook()
        first = self.state()["evaluatedAt"]
        time.sleep(0.02)
        _, out, _ = self.run_hook(event="UserPromptSubmit")
        self.assertEqual(out, "")
        self.assertGreater(self.state()["evaluatedAt"], first)

    def test_model_switch_announces_and_updates_state(self):
        self.run_hook()
        _, out, _ = self.run_hook(model=SONNET, event="UserPromptSubmit")
        self.assertIn("HARNESS INACTIVE", out)
        self.assertEqual((self.state()["status"], self.state()["model"]), ("off", SONNET))
        _, out, _ = self.run_hook(event="UserPromptSubmit")
        self.assertIn("HARNESS ACTIVE", out)
        self.assertEqual((self.state()["status"], self.state()["model"]), ("on", OPUS))

    def test_sessions_are_isolated(self):
        self.run_hook(session_id="a", model=OPUS)
        self.run_hook(session_id="b", model=SONNET)
        self.assertEqual(self.state("a")["status"], "on")
        self.assertEqual(self.state("b")["status"], "off")
        _, out, _ = self.run_hook(session_id="b", model=SONNET, event="UserPromptSubmit")
        self.assertEqual(out, "")

    def test_missing_or_invalid_session_writes_no_state(self):
        for session_id in (None, "", 7):
            code, _, _ = self.run_hook(session_id=session_id)
            self.assertEqual(code, 0)
        self.assertFalse(self.state_dir.exists())

    def test_path_like_session_id_is_hashed(self):
        session_id = "../../outside/セッション"
        self.run_hook(session_id=session_id)
        self.assertEqual([p.name for p in self.state_dir.iterdir()], [self.state_file(session_id).name])
        self.assertEqual(self.state(session_id)["sessionId"], session_id)
        self.assertFalse((self.home / "outside").exists())

    def test_missing_orchestrator_list_is_unknown_and_never_on(self):
        self.run_hook()
        (self.home / ".agents" / "harness-orchestrators.txt").unlink()
        code, out, err = self.run_hook(event="UserPromptSubmit")
        self.assertEqual((code, out), (0, ""))
        self.assertIn("configuration unreadable", err)
        self.assertNotIn(str(self.home), err)
        self.assertEqual((self.state()["status"], self.state()["reason"]), ("unknown", "configuration_error"))

    def test_missing_harness_text_is_unknown_not_on(self):
        (self.home / ".agents" / "harness-agent.md").unlink()
        code, out, _ = self.run_hook()
        self.assertEqual((code, out), (0, ""))
        state = self.state()
        self.assertEqual((state["status"], state["reason"], state["roles"]["orchestrator"]), ("unknown", "configuration_error", None))

    def test_role_models_are_null_when_unavailable(self):
        (self.home / ".codex" / "agents" / "implementer.toml").unlink()
        (self.home / ".codex" / "agents" / "reviewer.toml").write_text("model = [", encoding="utf-8")
        self.run_hook()
        self.assertEqual(self.state()["roles"], {"orchestrator": OPUS, "implementer": None, "reviewer": None})

    def test_invalid_utf8_role_model_keeps_instructions_and_status(self):
        for role in ("implementer", "reviewer"):
            with self.subTest(role=role):
                path = self.home / ".codex" / "agents" / f"{role}.toml"
                original = path.read_bytes()
                path.write_bytes(b'model = "\xff"')
                try:
                    code, out, err = self.run_hook(session_id=role)
                    self.assertEqual((code, err), (0, ""))
                    self.assertIn("HARNESS ACTIVE", out)
                    self.assertIn(HARNESS_TEXT, out)
                    state = self.state(role)
                    self.assertEqual((state["status"], state["reason"]), ("on", "orchestrator_model"))
                    expected_roles = {"orchestrator": OPUS, "implementer": "impl-model", "reviewer": "review-model"}
                    expected_roles[role] = None
                    self.assertEqual(state["roles"], expected_roles)
                finally:
                    path.write_bytes(original)

    def test_state_write_failure_still_delivers_instructions(self):
        self.state_dir.write_text("not a directory", encoding="utf-8")
        code, out, err = self.run_hook()
        self.assertEqual(code, 0)
        self.assertIn(HARNESS_TEXT, out)
        self.assertIn("could not save harness status", err)
        self.assertNotIn(str(self.home), err)


if __name__ == "__main__":
    unittest.main()

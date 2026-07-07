import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

interface LaunchResult {
  stdout: string;
  stderr: string;
  url: string | null;
}

export function activate(context: vscode.ExtensionContext) {
  const openCmd = vscode.commands.registerCommand(
    'markdownReviewViewer.open',
    async (uri?: vscode.Uri) => {
      await openInBrowser(uri);
    }
  );

  const openExternalCmd = vscode.commands.registerCommand(
    'markdownReviewViewer.openExternal',
    async (uri?: vscode.Uri) => {
      await openInBrowser(uri);
    }
  );

  const openWebviewCmd = vscode.commands.registerCommand(
    'markdownReviewViewer.openWebview',
    async (uri?: vscode.Uri) => {
      await openInWebview(uri, context);
    }
  );

  const legacyOpenCmd = vscode.commands.registerCommand(
    'prDraftViewer.open',
    async (uri?: vscode.Uri) => {
      await openInBrowser(uri);
    }
  );

  const legacyOpenExternalCmd = vscode.commands.registerCommand(
    'prDraftViewer.openExternal',
    async (uri?: vscode.Uri) => {
      await openInBrowser(uri);
    }
  );

  const legacyOpenWebviewCmd = vscode.commands.registerCommand(
    'prDraftViewer.openWebview',
    async (uri?: vscode.Uri) => {
      await openInWebview(uri, context);
    }
  );

  context.subscriptions.push(
    openCmd,
    openExternalCmd,
    openWebviewCmd,
    legacyOpenCmd,
    legacyOpenExternalCmd,
    legacyOpenWebviewCmd
  );
}

export function deactivate() {
  // nothing to clean up
}

async function openInBrowser(uri?: vscode.Uri): Promise<void> {
  const target = resolveMarkdownTarget(uri);
  if (!target) return;

  const bin = getLauncherBin();

  try {
    await launchViewer(bin, target.fsPath, 'external');
    vscode.window.setStatusBarMessage(
      `$(globe) Markdown Review Viewer: opened ${path.basename(target.fsPath)} in browser`,
      3000
    );
  } catch (err) {
    showLaunchError(bin, err);
  }
}

async function openInWebview(
  uri: vscode.Uri | undefined,
  context: vscode.ExtensionContext
): Promise<void> {
  const target = resolveMarkdownTarget(uri);
  if (!target) return;

  const bin = getLauncherBin();
  const filePath = target.fsPath;

  let launch: LaunchResult;
  try {
    launch = await launchViewer(bin, filePath, 'webview');
  } catch (err) {
    showLaunchError(bin, err);
    return;
  }

  if (!launch.url) {
    vscode.window.showErrorMessage(
      `Markdown Review Viewer: launcher did not print a Viewer URL.\n${launch.stdout.trim()}`
    );
    return;
  }

  const viewerUrl = withExtensionSession(launch.url);
  const panel = vscode.window.createWebviewPanel(
    'markdownReviewViewer',
    `Markdown Review: ${path.basename(filePath)}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      enableForms: true,
      retainContextWhenHidden: true,
    }
  );

  await postViewerSession(viewerUrl, '/api/session/open');
  panel.webview.html = renderWebviewHtml(viewerUrl, path.basename(filePath));
  panel.onDidDispose(
    () => {
      void postViewerSession(viewerUrl, '/api/session/close');
    },
    undefined,
    context.subscriptions
  );

  vscode.window.setStatusBarMessage(
    `$(globe) Markdown Review Viewer: opened ${path.basename(filePath)} in Webview`,
    3000
  );
}

function getLauncherBin(): string {
  const config = vscode.workspace.getConfiguration('markdownReviewViewer');
  const legacyConfig = vscode.workspace.getConfiguration('prDraftViewer');
  return (
    config.get<string>('binPath') ||
    legacyConfig.get<string>('binPath') ||
    'markdown-review-viewer'
  );
}

function resolveMarkdownTarget(uri?: vscode.Uri): vscode.Uri | undefined {
  // Resolve target file:
  //   1. URI argument (right-click on Explorer / Editor tab / Editor body)
  //   2. Fall back to the active editor's document
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    vscode.window.showWarningMessage('Markdown Review Viewer: no .md file selected.');
    return undefined;
  }
  if (!target.fsPath.toLowerCase().endsWith('.md')) {
    vscode.window.showWarningMessage(
      `Markdown Review Viewer: only .md files are supported (got ${target.fsPath}).`
    );
    return undefined;
  }
  return target;
}

function launchViewer(
  bin: string,
  filePath: string,
  mode: 'webview' | 'external'
): Promise<LaunchResult> {
  const args =
    mode === 'webview'
      ? ['--no-open', '--print-url', '--strict-root', filePath]
      : ['--strict-root', filePath];

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: mode === 'external',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      proc.kill();
      finish(() => reject(new Error('launcher timed out after 20 seconds')));
    }, 20_000);

    proc.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    proc.stderr?.on('data', (chunk) => (stderr += String(chunk)));

    proc.on('error', (err) => {
      finish(() => reject(err));
    });

    proc.on('exit', (code) => {
      finish(() => {
        if (code !== 0) {
          const tail = (stderr || stdout).trim().slice(-1000);
          reject(new Error(`launcher exited with code ${code}\n${tail}`));
          return;
        }

        resolve({
          stdout,
          stderr,
          url: extractViewerUrl(stdout),
        });
      });
    });

    if (mode === 'external') {
      proc.unref();
    }
  });
}

function extractViewerUrl(stdout: string): string | null {
  const match = stdout.match(/\[(?:markdown-review-viewer|pr-draft-viewer)\] URL (https?:\/\/[^\s]+)/);
  return match?.[1] ?? null;
}

function withExtensionSession(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set('session', 'extension');
  return url.toString();
}

function postViewerSession(
  viewerUrl: string,
  endpoint: '/api/session/open' | '/api/session/close'
): Promise<void> {
  return new Promise((resolve) => {
    const url = new URL(endpoint, viewerUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      {
        method: 'POST',
        timeout: 2_000,
        headers: {
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );

    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end('{}');
  });
}

function renderWebviewHtml(viewerUrl: string, title: string): string {
  const escapedUrl = escapeHtml(viewerUrl);
  const escapedTitle = escapeHtml(title);
  const viewerOrigin = new URL(viewerUrl).origin;
  const escapedViewerOrigin = escapeHtml(viewerOrigin);
  const csp = [
    "default-src 'none'",
    `frame-src ${escapedViewerOrigin}`,
    "style-src 'unsafe-inline'",
  ].join('; ');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #0d1117;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
    }
  </style>
</head>
<body>
  <iframe
    src="${escapedUrl}"
    title="${escapedTitle}"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation"
  ></iframe>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function showLaunchError(bin: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  vscode.window
    .showErrorMessage(
      `Markdown Review Viewer: failed to launch '${bin}'.\n${message}`,
      'Open Settings'
    )
    .then((sel) => {
      if (sel === 'Open Settings') {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'markdownReviewViewer.binPath'
        );
      }
    });
}

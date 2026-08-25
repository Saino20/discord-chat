import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Client, GatewayIntentBits, TextChannel, Message, ChannelType, Partials } from 'discord.js';

let discordClient: Client | null = null;
let currentChannelId: string | null = null;
let currentDMUserId: string | null = null;
let isCurrentDM = false;
let activeToken: string | null = null;
const TOKEN_KEY = 'easy_discord_token';
const fileContentCache: { [url: string]: string } = {};

export function activate(context: vscode.ExtensionContext) {
  const provider = new DiscordSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('discordChat.sidebarView', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}

class DiscordSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  public async resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      enableForms: true,
      localResourceRoots: [this._context.extensionUri]
    };

    webviewView.webview.html = this.getHtmlContent();

    this._context.secrets.get(TOKEN_KEY).then((savedToken) => {
      if (savedToken) {
        activeToken = savedToken;
        this.connectDiscord(savedToken);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (data) => {
      try {
        switch (data.command) {
          case 'SAVE_TOKEN':
            activeToken = data.token;
            await this._context.secrets.store(TOKEN_KEY, data.token);
            this.connectDiscord(data.token);
            break;

          case 'RESET_TOKEN':
            activeToken = null;
            await this._context.secrets.delete(TOKEN_KEY);
            if (discordClient) {
              discordClient.destroy();
              discordClient = null;
            }
            this._view?.webview.postMessage({ type: 'RESET_VIEW' });
            break;

          case 'REFRESH_DATA':
            await this.broadcastServers();
            break;

          case 'SWITCH_CHANNEL':
            isCurrentDM = false;
            currentChannelId = String(data.id);
            this.loadChannelHistory(currentChannelId);
            break;

          case 'SWITCH_DM':
            isCurrentDM = true;
            currentDMUserId = String(data.id);
            this.loadDMHistory(currentDMUserId);
            break;

          case 'SEND_MESSAGE':
            await this.sendMessageToDiscord(data.text, data.targetId || currentChannelId, data.replyTo, data.attachmentPath);
            this._view?.webview.postMessage({ type: 'UPLOAD_FINISHED' });
            break;

          case 'SEND_DM':
            await this.sendDMToUser(data.text, data.targetId || currentDMUserId, data.replyTo, data.attachmentPath);
            this._view?.webview.postMessage({ type: 'UPLOAD_FINISHED' });
            break;

          case 'SEND_QUICK_CODE': {
            await this.handleQuickSnippet(data.targetId, data.isDM);
            break;
          }

          case 'FETCH_FILE_PREVIEW': {
            const text = await this.fetchFileContent(data.url);
            this._view?.webview.postMessage({
              type: 'FILE_PREVIEW_RESULT',
              elementId: data.elementId,
              text: text.slice(0, 15000)
            });
            break;
          }

          case 'COPY_TEXT_FROM_URL': {
            const text = await this.fetchFileContent(data.url);
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage('Code copied to clipboard!');
            break;
          }

          case 'INSERT_CODE_FROM_URL': {
            const text = await this.fetchFileContent(data.url);
            const editor = vscode.window.activeTextEditor;
            if (editor) {
              editor.edit((edit) => edit.insert(editor.selection.active, text));
            } else {
              vscode.window.showWarningMessage('Open an active editor tab first to insert code.');
            }
            break;
          }

          case 'PREVIEW_FILE_IN_EDITOR': {
            const text = await this.fetchFileContent(data.url);
            const ext = (data.filename || 'txt').split('.').pop();
            const doc = await vscode.workspace.openTextDocument({
              content: text,
              language: ext || 'plaintext'
            });
            await vscode.window.showTextDocument(doc, { preview: true });
            break;
          }

          case 'EDIT_MESSAGE':
            this.editMessage(data.channelId || currentChannelId, String(data.messageId), data.text);
            break;

          case 'DELETE_MESSAGE':
            this.deleteMessage(data.channelId || currentChannelId, String(data.messageId));
            break;

          case 'ADD_REACTION':
            this.addReaction(data.channelId || currentChannelId, String(data.messageId), data.emoji);
            break;

          case 'OPEN_FILE_DIALOG': {
            const fileUri = await vscode.window.showOpenDialog({ canSelectMany: false });
            if (fileUri && fileUri[0]) {
              this._view?.webview.postMessage({
                type: 'FILE_SELECTED',
                filePath: fileUri[0].fsPath,
                fileName: path.basename(fileUri[0].fsPath)
              });
            }
            break;
          }

          case 'DOWNLOAD_ATTACHMENT': {
            const response = await fetch(data.url);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
              vscode.window.showWarningMessage('Open a workspace folder first to save files.');
              return;
            }
            const targetUri = vscode.Uri.joinPath(workspaceFolders[0].uri, data.filename);
            await vscode.workspace.fs.writeFile(targetUri, buffer);
            vscode.window.showInformationMessage(`Saved ${data.filename} to workspace!`);
            break;
          }
        }
      } catch (err: any) {
        this._view?.webview.postMessage({ type: 'UPLOAD_FINISHED' });
        vscode.window.showErrorMessage(`Action Error: ${err.message}`);
      }
    });
  }

  private async fetchFileContent(url: string): Promise<string> {
    if (fileContentCache[url]) return fileContentCache[url];
    try {
      const res = await fetch(url);
      const text = await res.text();
      fileContentCache[url] = text;
      return text;
    } catch {
      return '(Could not fetch code content)';
    }
  }

  private async getOrCreateDMChannelId(userId: string): Promise<string> {
    if (!activeToken) throw new Error('Bot token missing');

    const res = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${activeToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ recipient_id: userId })
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to open DM channel: ${err}`);
    }

    const data: any = await res.json();
    return data.id;
  }

  private async uploadViaRest(targetChannelId: string, filePath: string, text?: string, replyToId?: string) {
    if (!activeToken) throw new Error('Bot token missing');

    const fileData = await fs.promises.readFile(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    const blob = new Blob([fileData]);
    formData.append('files[0]', blob, fileName);

    const payloadJson: any = {
      attachments: [
        {
          id: 0,
          filename: fileName,
          description: fileName
        }
      ]
    };

    if (text && text.trim().length > 0) {
      payloadJson.content = text.trim();
    }
    if (replyToId) {
      payloadJson.message_reference = { message_id: replyToId };
    }

    formData.append('payload_json', JSON.stringify(payloadJson));

    const response = await fetch(`https://discord.com/api/v10/channels/${targetChannelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${activeToken}`
      },
      body: formData
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Upload error (${response.status}): ${errText}`);
    }
  }

  private async sendMessageToDiscord(text: string, channelId?: string, replyToId?: string, attachmentPath?: string) {
    const targetChannelId = channelId || currentChannelId;
    if (!targetChannelId) return;

    try {
      if (attachmentPath && fs.existsSync(attachmentPath)) {
        await this.uploadViaRest(targetChannelId, attachmentPath, text, replyToId);
      } else {
        const channel = (await discordClient?.channels.fetch(targetChannelId)) as TextChannel;
        if (channel && text && text.trim().length > 0) {
          if (replyToId) {
            const targetMsg = await channel.messages.fetch(replyToId);
            await targetMsg.reply({ content: text.trim() });
          } else {
            await channel.send({ content: text.trim() });
          }
        }
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Send failed: ${e.message}`);
    }
  }

  private async sendDMToUser(text: string, userId?: string, replyToId?: string, attachmentPath?: string) {
    const targetUserId = userId || currentDMUserId;
    if (!targetUserId) return;

    try {
      const dmChannelId = await this.getOrCreateDMChannelId(targetUserId);

      if (attachmentPath && fs.existsSync(attachmentPath)) {
        await this.uploadViaRest(dmChannelId, attachmentPath, text, replyToId);
      } else if (text && text.trim().length > 0) {
        if (replyToId && discordClient) {
          const user = await discordClient.users.fetch(targetUserId);
          const dm = await user.createDM();
          const targetMsg = await dm.messages.fetch(replyToId);
          await targetMsg.reply({ content: text.trim() });
        } else if (discordClient) {
          const user = await discordClient.users.fetch(targetUserId);
          await user.send({ content: text.trim() });
        }
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`DM failed: ${e.message}`);
    }
  }

  private async handleQuickSnippet(targetId?: string, isDM?: boolean) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '📄 Send Active File as Attachment', description: 'Sends complete file with real code extension' },
        { label: '💻 Send Active Terminal / Output', description: 'Sends complete terminal output as .log file' },
        { label: '⚡ Send Both (Code File + Terminal Log)', description: 'Sends both active file and terminal logs' }
      ],
      { placeHolder: 'Select what you want to share:' }
    );

    if (!choice) return;

    let targetChannelId = targetId || (isDM ? currentDMUserId : currentChannelId);
    if (!targetChannelId) return;

    if (isDM) {
      targetChannelId = await this.getOrCreateDMChannelId(targetChannelId);
    }

    if (choice.label.includes('File') || choice.label.includes('Both')) {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const filePath = editor.document.fileName;
        const fileName = path.basename(filePath);
        const codeContent = editor.document.getText();
        
        let uploadPath = filePath;
        let isTemp = false;

        if (editor.document.isUntitled || !fs.existsSync(filePath)) {
          uploadPath = path.join(this._context.extensionPath, `temp_${fileName}`);
          await fs.promises.writeFile(uploadPath, codeContent, 'utf8');
          isTemp = true;
        }

        try {
          await this.uploadViaRest(targetChannelId, uploadPath, `⚡ **Shared file:** \`${fileName}\``);
        } finally {
          if (isTemp && fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath);
        }
      } else {
        vscode.window.showWarningMessage('No active editor tab found.');
      }
    }

    if (choice.label.includes('Terminal') || choice.label.includes('Both')) {
      try {
        await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
        await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
        await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
        const clipboardText = (await vscode.env.clipboard.readText()).trim();

        if (clipboardText) {
          const tempLogPath = path.join(this._context.extensionPath, `terminal_output_${Date.now()}.log`);
          await fs.promises.writeFile(tempLogPath, clipboardText, 'utf8');
          try {
            await this.uploadViaRest(targetChannelId, tempLogPath, `💻 **Terminal Output Log**`);
          } finally {
            if (fs.existsSync(tempLogPath)) fs.unlinkSync(tempLogPath);
          }
        } else {
          vscode.window.showInformationMessage('Active terminal was empty.');
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Terminal capture failed: ${err.message}`);
      }
    }
  }

  private connectDiscord(token: string) {
    if (discordClient) discordClient.destroy();

    discordClient = new Client({
      rest: {
        timeout: 60000,
        retries: 3
      },
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction]
    });

    discordClient.on('ready', async () => {
      await this.broadcastServers(true);
    });

    discordClient.on('guildCreate', () => this.broadcastServers());
    discordClient.on('guildDelete', () => this.broadcastServers());
    discordClient.on('channelCreate', () => this.broadcastServers());
    discordClient.on('channelDelete', () => this.broadcastServers());

    discordClient.on('messageCreate', (msg) => {
      if (!isCurrentDM && msg.channelId === currentChannelId) {
        this._view?.webview.postMessage({ type: 'NEW_MESSAGE', payload: this.formatMessage(msg) });
      } else if (isCurrentDM && (msg.author.id === currentDMUserId || (msg.author.id === discordClient?.user?.id && msg.channel.isDMBased()))) {
        this._view?.webview.postMessage({ type: 'NEW_MESSAGE', payload: this.formatMessage(msg) });
      }
    });

    discordClient.on('messageReactionAdd', (reaction) => {
      if (!isCurrentDM && reaction.message.channelId === currentChannelId) {
        this.loadChannelHistory(currentChannelId);
      } else if (isCurrentDM && currentDMUserId) {
        this.loadDMHistory(currentDMUserId);
      }
    });

    discordClient.login(token).catch((err) => {
      vscode.window.showErrorMessage(`Discord Login Failed: ${err.message}`);
      this._view?.webview.postMessage({ type: 'LOGIN_ERROR', error: err.message });
    });
  }

  private async getServersData() {
    if (!discordClient || !discordClient.isReady()) return [];
    const servers: {
      id: string;
      name: string;
      channels: { id: string; name: string }[];
      members: { id: string; name: string }[];
    }[] = [];

    for (const guild of discordClient.guilds.cache.values()) {
      const textChannels: { id: string; name: string }[] = [];
      const memberList: { id: string; name: string }[] = [];

      guild.channels.cache.forEach((ch) => {
        if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) {
          textChannels.push({ id: ch.id, name: ch.name });
        }
      });

      try {
        const fetchedMembers = await guild.members.fetch();
        fetchedMembers.forEach((m) => {
          if (!m.user.bot) memberList.push({ id: m.user.id, name: m.displayName || m.user.username });
        });
      } catch {
        guild.members.cache.forEach((m) => {
          if (!m.user.bot) memberList.push({ id: m.user.id, name: m.displayName || m.user.username });
        });
      }

      textChannels.sort((a, b) => a.name.localeCompare(b.name));
      memberList.sort((a, b) => a.name.localeCompare(b.name));

      servers.push({
        id: guild.id,
        name: guild.name,
        channels: textChannels,
        members: memberList
      });
    }

    return servers;
  }

  private async broadcastServers(isInitial = false) {
    const servers = await this.getServersData();
    if (servers.length > 0 && !currentChannelId) {
      const firstGuild = servers.find((s) => s.channels.length > 0);
      currentChannelId = firstGuild ? firstGuild.channels[0].id : null;
    }

    if (isInitial) {
      this._view?.webview.postMessage({
        type: 'CONNECTED',
        botName: discordClient?.user?.username || 'Bot',
        servers,
        activeServerId: servers[0]?.id || null,
        activeChannelId: currentChannelId
      });
      if (currentChannelId) this.loadChannelHistory(currentChannelId);
    } else {
      this._view?.webview.postMessage({ type: 'SERVERS_UPDATED', servers });
    }
  }

  private async loadChannelHistory(channelId: string) {
    if (!discordClient || !channelId) return;
    try {
      const channel = (await discordClient.channels.fetch(channelId)) as TextChannel;
      if (!channel) return;
      const messages = await channel.messages.fetch({ limit: 35 });
      const formatted = Array.from(messages.values()).reverse().map((m) => this.formatMessage(m));
      this._view?.webview.postMessage({ type: 'HISTORY', messages: formatted });
    } catch (e) {
      console.error(e);
    }
  }

  private async loadDMHistory(userId: string) {
    if (!discordClient || !userId) return;
    try {
      const user = await discordClient.users.fetch(userId);
      const dm = await user.createDM();
      const messages = await dm.messages.fetch({ limit: 35 });
      const formatted = Array.from(messages.values()).reverse().map((m) => this.formatMessage(m));
      this._view?.webview.postMessage({ type: 'HISTORY', messages: formatted });
    } catch (e) {
      console.error(e);
    }
  }

  private async editMessage(channelId: string, messageId: string, newText: string) {
    if (!discordClient || !channelId) return;
    try {
      const ch = (await discordClient.channels.fetch(channelId)) as TextChannel;
      const msg = await ch.messages.fetch(messageId);
      if (msg.author.id !== discordClient.user?.id) {
        vscode.window.showWarningMessage('Discord only permits editing bot-owned messages.');
        return;
      }
      await msg.edit(newText);
      this._view?.webview.postMessage({ type: 'MESSAGE_EDITED', messageId, newText });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Edit failed: ${e.message}`);
    }
  }

  private async deleteMessage(channelId: string, messageId: string) {
    if (!discordClient || !channelId) return;
    try {
      const ch = (await discordClient.channels.fetch(channelId)) as TextChannel;
      const msg = await ch.messages.fetch(messageId);
      await msg.delete();
      this._view?.webview.postMessage({ type: 'MESSAGE_DELETED', messageId });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Delete failed: ${e.message}`);
    }
  }

  private async addReaction(channelId: string, messageId: string, emoji: string) {
    if (!discordClient || !channelId) return;
    try {
      const ch = (await discordClient.channels.fetch(channelId)) as TextChannel;
      const msg = await ch.messages.fetch(messageId);
      await msg.react(emoji);
      
      if (isCurrentDM && currentDMUserId) {
        this.loadDMHistory(currentDMUserId);
      } else {
        this.loadChannelHistory(channelId);
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Reaction failed: ${e.message}`);
    }
  }

  private formatMessage(msg: Message) {
    const reactions = msg.reactions.cache.map((r) => ({
      emoji: r.emoji.name || '👍',
      count: r.count
    }));

    return {
      id: String(msg.id),
      channelId: String(msg.channelId),
      author: msg.author.username,
      avatar: msg.author.displayAvatarURL(),
      isBot: msg.author.bot,
      isMine: msg.author.id === discordClient?.user?.id,
      content: msg.content,
      replyTo: msg.reference?.messageId ? { author: 'User', content: 'Quoted reference' } : null,
      reactions: reactions,
      attachments: msg.attachments.map((a) => ({ name: a.name, url: a.url, size: a.size })),
      time: msg.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
  }

  private getHtmlContent(): string {
    const htmlPath = path.join(this._context.extensionPath, 'media', 'index.html');
    return fs.readFileSync(htmlPath, 'utf8');
  }
}

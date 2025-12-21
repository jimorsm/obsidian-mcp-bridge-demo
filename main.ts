import { Notice, Plugin, requestUrl } from "obsidian";
import http, { IncomingMessage, ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";

type Point = { x: number; y: number };
type PointPair = [number, number];

type ServerElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  points?: Point[];
  startArrowhead?: string | null;
  endArrowhead?: string | null;
};

type WebSocketMessage = {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  source?: string;
};

interface BridgeSettings {
  wsUrl: string;
  apiBaseUrl: string;
  outboundApiBaseUrl?: string;
  serverEnabled: boolean;
  serverHost: string;
  serverPort: number;
  autoSyncEnabled: boolean;
  autoSyncIntervalMs: number;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  wsUrl: "ws://localhost:3000",
  apiBaseUrl: "http://localhost:3000",
  outboundApiBaseUrl: "",
  serverEnabled: true,
  serverHost: "127.0.0.1",
  serverPort: 3030,
  autoSyncEnabled: true,
  autoSyncIntervalMs: 1500,
};

export default class McpExcalidrawBridgeDemo extends Plugin {
  private ws: WebSocket | null = null;
  private settings: BridgeSettings = DEFAULT_SETTINGS;
  private proxyServer: http.Server | null = null;
  private proxyWss: WebSocketServer | null = null;
  private proxyClients = new Set<WebSocket>();
  private elements = new Map<string, ServerElement>();
  private autoSyncTimer: number | null = null;
  private lastSceneHash = "";
  private lastElementHashes = new Map<string, string>();
  private suppressOutboundUntil = 0;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "mcp-excalidraw-bridge-reconnect",
      name: "Reconnect MCP Excalidraw WebSocket",
      callback: () => this.connectWebSocket(true),
    });

    this.addCommand({
      id: "mcp-excalidraw-bridge-push",
      name: "Push active Excalidraw scene to MCP",
      callback: () => this.pushActiveScene(),
    });

    this.connectWebSocket(false);
    this.startProxyServer();
    this.startAutoSync();
  }

  onunload() {
    if (this.ws) {
      this.ws.close();
    }
    this.stopProxyServer();
    this.stopAutoSync();
  }

  private async loadSettings() {
    const loaded = (await this.loadData()) as Partial<BridgeSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  }

  private connectWebSocket(showNotice: boolean) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (showNotice) new Notice("MCP Excalidraw WS already connected");
      return;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.ws = new WebSocket(this.settings.wsUrl);

    this.ws.onopen = () => {
      if (showNotice) new Notice("MCP Excalidraw WS connected");
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        this.handleWebSocketMessage(data);
      } catch (error) {
        console.error("Bridge WS parse error", error);
      }
    };

    this.ws.onerror = () => {
      if (showNotice) new Notice("MCP Excalidraw WS error");
    };

    this.ws.onclose = () => {
      if (showNotice) new Notice("MCP Excalidraw WS closed");
    };
  }

  private getTargetExcalidrawView(): any | null {
    const activeLeaf = this.app.workspace.getActiveLeaf();
    const activeView = activeLeaf?.view as any;
    if (activeView?.getViewType && activeView.getViewType() === "excalidraw") {
      return activeView;
    }

    const leaves = this.app.workspace.getLeavesOfType("excalidraw");
    return leaves.length > 0 ? (leaves[0].view as any) : null;
  }

  private getEA(view: any): any | null {
    const eaGlobal = (window as any).ExcalidrawAutomate;
    if (!eaGlobal || typeof eaGlobal.getAPI !== "function") {
      return null;
    }
    return eaGlobal.getAPI(view);
  }

  private getViewForWrite(silent: boolean): any | null {
    const view = this.getTargetExcalidrawView();
    if (!view && !silent) {
      new Notice("No active Excalidraw view");
    }
    return view;
  }

  private applyStyle(ea: any, element: ServerElement) {
    if (!ea?.style) return;

    if (element.strokeColor) ea.style.strokeColor = element.strokeColor;
    if (element.backgroundColor) ea.style.backgroundColor = element.backgroundColor;
    if (typeof element.strokeWidth === "number") ea.style.strokeWidth = element.strokeWidth;
    if (typeof element.roughness === "number") ea.style.roughness = element.roughness;
    if (typeof element.opacity === "number") ea.style.opacity = element.opacity;
    if (typeof element.fontSize === "number") ea.style.fontSize = element.fontSize;

    if (typeof element.fontFamily !== "undefined") {
      const family = Number(element.fontFamily);
      if (!Number.isNaN(family) && typeof ea.setFontFamily === "function") {
        ea.setFontFamily(family);
      } else if (!Number.isNaN(family)) {
        ea.style.fontFamily = family;
      }
    }
  }

  private pointsToPairs(points?: Point[]): [number, number][] {
    if (!points || points.length === 0) return [[0, 0], [0, 0]];
    if (Array.isArray(points[0])) {
      return points as PointPair[];
    }
    return (points as Point[]).map((p) => [p.x, p.y]);
  }

  private async applyCreate(element: ServerElement, silent: boolean = false) {
    const view = this.getViewForWrite(silent);
    if (!view) return;

    const ea = this.getEA(view);
    if (!ea) {
      if (!silent) new Notice("Excalidraw Automate API not available");
      return;
    }

    ea.reset();
    this.applyStyle(ea, element);

    switch (element.type) {
      case "rectangle":
        ea.addRect(element.x, element.y, element.width ?? 100, element.height ?? 60, element.id);
        break;
      case "ellipse":
        ea.addEllipse(element.x, element.y, element.width ?? 100, element.height ?? 60, element.id);
        break;
      case "diamond":
        ea.addDiamond(element.x, element.y, element.width ?? 100, element.height ?? 60, element.id);
        break;
      case "text":
        ea.addText(element.x, element.y, element.text ?? "", undefined, element.id);
        break;
      case "arrow":
        ea.addArrow(this.pointsToPairs(element.points), {
          startArrowHead: element.startArrowhead ?? undefined,
          endArrowHead: element.endArrowhead ?? undefined,
        }, element.id);
        break;
      case "line":
        ea.addLine(this.pointsToPairs(element.points), element.id);
        break;
      default:
        console.warn("Unsupported element type", element.type);
        ea.destroy();
        return;
    }

    await ea.addElementsToView(false, true, true);
    ea.destroy();
    this.elements.set(element.id, element);
    this.lastElementHashes.set(element.id, this.hashElementPayload(element));
    this.suppressOutboundUntil = Date.now() + 1000;
  }

  private async applyUpdate(element: ServerElement, silent: boolean = false) {
    const view = this.getViewForWrite(silent);
    if (!view) return;

    const ea = this.getEA(view);
    if (!ea) return;

    const existing = ea.getViewElements().find((el: any) => el.id === element.id);
    if (existing) {
      ea.deleteViewElements([existing]);
    }

    ea.destroy();
    await this.applyCreate(element, silent);
  }

  private async applyDelete(elementId: string, silent: boolean = false) {
    const view = this.getViewForWrite(silent);
    if (!view) return;

    const ea = this.getEA(view);
    if (!ea) return;

    const existing = ea.getViewElements().find((el: any) => el.id === elementId);
    if (existing) {
      ea.deleteViewElements([existing]);
    }

    ea.destroy();
    this.elements.delete(elementId);
    this.lastElementHashes.delete(elementId);
    this.suppressOutboundUntil = Date.now() + 1000;
  }

  private async handleWebSocketMessage(message: WebSocketMessage) {
    switch (message.type) {
      case "initial_elements":
        if (message.elements) {
          for (const element of message.elements) {
            await this.applyUpdate(element);
          }
        }
        break;
      case "element_created":
        if (message.element) await this.applyCreate(message.element);
        break;
      case "element_updated":
        if (message.element) await this.applyUpdate(message.element);
        break;
      case "element_deleted":
        if (message.elementId) await this.applyDelete(message.elementId);
        break;
      default:
        break;
    }
  }

  private async pushActiveScene() {
    const view = this.getTargetExcalidrawView();
    if (!view) {
      new Notice("No active Excalidraw view");
      return;
    }

    const ea = this.getEA(view);
    if (!ea) {
      new Notice("Excalidraw Automate API not available");
      return;
    }

    const elements = ea.getViewElements();
    ea.destroy();

    try {
      await this.pushSceneElements(elements);
      new Notice("Pushed active scene to MCP Excalidraw");
    } catch (error) {
      console.error("Push scene failed", error);
      new Notice("Push scene failed, check console");
    }
  }

  private startAutoSync() {
    if (!this.settings.autoSyncEnabled) return;
    if (this.autoSyncTimer) return;
    this.autoSyncTimer = window.setInterval(() => {
      this.autoSyncTick();
    }, this.settings.autoSyncIntervalMs);
  }

  private stopAutoSync() {
    if (this.autoSyncTimer) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  private async autoSyncTick() {
    if (Date.now() < this.suppressOutboundUntil) {
      return;
    }

    const view = this.getTargetExcalidrawView();
    if (!view) return;

    const ea = this.getEA(view);
    if (!ea) return;

    const elements = ea.getViewElements();
    ea.destroy();

    const hash = this.hashElements(elements);
    if (hash === this.lastSceneHash) return;

    const currentElements = elements.map((el: any) => this.extractElementFromView(el));
    const currentHashes = new Map<string, string>();
    currentElements.forEach((element) => {
      currentHashes.set(element.id, this.hashElementPayload(element));
    });

    this.broadcastLocalDiffs(currentElements, currentHashes);
    this.updateLocalCache(currentElements, currentHashes);

    this.lastSceneHash = hash;
    try {
      await this.pushSceneElements(elements, true);
    } catch (error) {
      console.error("Auto sync failed", error);
    }
  }

  private async pushSceneElements(elements: any[], silent: boolean = false) {
    const baseUrl = this.settings.outboundApiBaseUrl?.trim() || this.settings.apiBaseUrl;
    await requestUrl({
      url: `${baseUrl}/api/elements/sync`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elements,
        timestamp: new Date().toISOString(),
      }),
    });
    if (!silent) {
      new Notice("Pushed active scene to MCP Excalidraw");
    }
  }

  private extractElementFromView(element: any): ServerElement {
    return {
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      points: element.points,
      text: element.text,
      backgroundColor: element.backgroundColor,
      strokeColor: element.strokeColor,
      strokeWidth: element.strokeWidth,
      roughness: element.roughness,
      opacity: element.opacity,
      fontSize: element.fontSize,
      fontFamily: element.fontFamily,
      startArrowhead: element.startArrowhead,
      endArrowhead: element.endArrowhead,
    };
  }

  private hashElementPayload(element: ServerElement): string {
    return JSON.stringify({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      points: element.points,
      text: element.text,
      strokeColor: element.strokeColor,
      backgroundColor: element.backgroundColor,
      strokeWidth: element.strokeWidth,
      roughness: element.roughness,
      opacity: element.opacity,
      fontSize: element.fontSize,
      fontFamily: element.fontFamily,
      startArrowhead: element.startArrowhead,
      endArrowhead: element.endArrowhead,
    });
  }

  private broadcastLocalDiffs(
    currentElements: ServerElement[],
    currentHashes: Map<string, string>,
  ) {
    const currentIds = new Set(currentElements.map((el) => el.id));

    currentElements.forEach((element) => {
      const previous = this.lastElementHashes.get(element.id);
      const current = currentHashes.get(element.id);
      if (!previous) {
        this.broadcast({ type: "element_created", element });
      } else if (previous !== current) {
        this.broadcast({ type: "element_updated", element });
      }
    });

    this.lastElementHashes.forEach((_hash, id) => {
      if (!currentIds.has(id)) {
        this.broadcast({ type: "element_deleted", elementId: id });
      }
    });
  }

  private updateLocalCache(
    currentElements: ServerElement[],
    currentHashes: Map<string, string>,
  ) {
    this.elements.clear();
    currentElements.forEach((element) => {
      this.elements.set(element.id, element);
    });
    this.lastElementHashes = currentHashes;
  }

  private hashElements(elements: any[]): string {
    const minimal = elements.map((el: any) => ({
      id: el.id,
      type: el.type,
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      points: el.points,
      text: el.text,
      strokeColor: el.strokeColor,
      backgroundColor: el.backgroundColor,
      strokeWidth: el.strokeWidth,
      roughness: el.roughness,
      opacity: el.opacity,
      fontSize: el.fontSize,
      fontFamily: el.fontFamily,
      startArrowhead: el.startArrowhead,
      endArrowhead: el.endArrowhead,
    }));
    return JSON.stringify(minimal);
  }

  private startProxyServer() {
    if (!this.settings.serverEnabled) return;
    if (this.proxyServer) return;

    this.proxyServer = http.createServer((req, res) => {
      this.handleProxyRequest(req, res);
    });

    this.proxyWss = new WebSocketServer({ server: this.proxyServer });
    this.proxyWss.on("connection", (socket: WebSocket) => {
      this.proxyClients.add(socket);
      const initial: WebSocketMessage = {
        type: "initial_elements",
        elements: Array.from(this.elements.values()),
      };
      socket.send(JSON.stringify(initial));
      const syncStatus = {
        type: "sync_status",
        elementCount: this.elements.size,
        timestamp: new Date().toISOString(),
      };
      socket.send(JSON.stringify(syncStatus));
      socket.on("close", () => this.proxyClients.delete(socket));
      socket.on("error", () => this.proxyClients.delete(socket));
    });

    this.proxyServer.listen(this.settings.serverPort, this.settings.serverHost, () => {
      new Notice(`Bridge proxy server listening on ${this.settings.serverHost}:${this.settings.serverPort}`);
    });
  }

  private stopProxyServer() {
    if (this.proxyWss) {
      this.proxyWss.close();
      this.proxyWss = null;
    }
    if (this.proxyServer) {
      this.proxyServer.close();
      this.proxyServer = null;
    }
    this.proxyClients.clear();
  }

  private broadcast(message: WebSocketMessage) {
    const data = JSON.stringify(message);
    this.proxyClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  private async handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", `http://${this.settings.serverHost}:${this.settings.serverPort}`);
      const { pathname } = url;
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && pathname === "/api/elements") {
        return this.sendJson(res, 200, {
          success: true,
          elements: Array.from(this.elements.values()),
          count: this.elements.size,
        });
      }

      if (method === "GET" && pathname === "/api/sync/status") {
        return this.sendJson(res, 200, {
          success: true,
          count: this.elements.size,
          timestamp: new Date().toISOString(),
        });
      }

      if (method === "GET" && pathname.startsWith("/api/elements/")) {
        const id = pathname.split("/").pop() ?? "";
        const element = this.elements.get(id);
        if (!element) {
          return this.sendJson(res, 404, { success: false, error: "Element not found" });
        }
        return this.sendJson(res, 200, { success: true, element });
      }

      if (method === "POST" && pathname === "/api/elements") {
        const body = await this.readJson(req);
        const element = this.normalizeElement(body);
        this.elements.set(element.id, element);
        await this.applyCreate(element, true);
        this.broadcast({ type: "element_created", element });
        return this.sendJson(res, 200, { success: true, element });
      }

      if (method === "PUT" && pathname.startsWith("/api/elements/")) {
        const id = pathname.split("/").pop() ?? "";
        const body = await this.readJson(req);
        const existing = this.elements.get(id);
        if (!existing) {
          return this.sendJson(res, 404, { success: false, error: "Element not found" });
        }
        const updated = { ...existing, ...body, id };
        this.elements.set(id, updated);
        await this.applyUpdate(updated, true);
        this.broadcast({ type: "element_updated", element: updated });
        return this.sendJson(res, 200, { success: true, element: updated });
      }

      if (method === "DELETE" && pathname.startsWith("/api/elements/")) {
        const id = pathname.split("/").pop() ?? "";
        if (!this.elements.has(id)) {
          return this.sendJson(res, 404, { success: false, error: "Element not found" });
        }
        this.elements.delete(id);
        await this.applyDelete(id, true);
        this.broadcast({ type: "element_deleted", elementId: id });
        return this.sendJson(res, 200, { success: true });
      }

      if (method === "POST" && pathname === "/api/elements/batch") {
        const body = await this.readJson(req);
        const elements = Array.isArray(body?.elements) ? body.elements : [];
        const processed: ServerElement[] = [];
        for (const element of elements) {
          const normalized = this.normalizeElement(element);
          this.elements.set(normalized.id, normalized);
          processed.push(normalized);
          await this.applyCreate(normalized, true);
        }
        this.broadcast({ type: "elements_batch_created", elements: processed });
        return this.sendJson(res, 200, { success: true, elements: processed, count: processed.length });
      }

      if (method === "POST" && pathname === "/api/elements/sync") {
        const body = await this.readJson(req);
        const elements = Array.isArray(body?.elements) ? body.elements : [];
        this.elements.clear();
        const processed: ServerElement[] = [];
        for (const element of elements) {
          const normalized = this.normalizeElement(element);
          this.elements.set(normalized.id, normalized);
          processed.push(normalized);
          await this.applyUpdate(normalized, true);
        }
        this.broadcast({ type: "elements_synced", count: processed.length, timestamp: new Date().toISOString() });
        return this.sendJson(res, 200, { success: true, count: processed.length });
      }

      return this.sendJson(res, 404, { success: false, error: "Not found" });
    } catch (error) {
      console.error("Proxy server error", error);
      return this.sendJson(res, 500, { success: false, error: "Internal error" });
    }
  }

  private async readJson(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const data = Buffer.concat(chunks).toString("utf8");
    return data ? JSON.parse(data) : {};
  }

  private normalizeElement(raw: any): ServerElement {
    const id = typeof raw?.id === "string" ? raw.id : `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return { ...raw, id } as ServerElement;
  }

  private sendJson(res: ServerResponse, status: number, payload: any) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  }
}

/**
 * Phase 2: Search Proxy
 * 
 * HTTP proxy for search operations with guardrail integration.
 * Provides a controlled interface for executing search/lookup operations
 * with configurable output limits and content filtering.
 * 
 * Architecture:
 * - Proxy class wraps search execution with configurable limits
 * - Integrates with Guardrail (Phase 3) for output processing
 * - Supports streaming and batch operations
 * - Configurable timeouts and retry logic
 */

import { Guardrail, GuardrailPresets, type GuardrailConfig } from './guardrail.js';

// ═══ Configuration ═══

export interface SearchProxyConfig {
  /** Maximum execution time in milliseconds */
  timeoutMs: number;
  /** Default guardrail configuration */
  guardrail: GuardrailConfig;
  /** Whether to enable verbose logging */
  verbose: boolean;
  /** Maximum retries on failure */
  maxRetries: number;
  /** Base delay between retries in ms */
  retryDelayMs: number;
}

export const DEFAULT_SEARCH_PROXY_CONFIG: SearchProxyConfig = {
  timeoutMs: 60000,
  guardrail: GuardrailPresets.production,
  verbose: false,
  maxRetries: 3,
  retryDelayMs: 1000,
};

// ═══ Search Proxy ═══

export class SearchProxy {
  private config: SearchProxyConfig;
  private guardrail: Guardrail;
  private lastError?: Error;

  constructor(config: Partial<SearchProxyConfig> = {}) {
    this.config = { ...DEFAULT_SEARCH_PROXY_CONFIG, ...config };
    this.guardrail = new Guardrail(this.config.guardrail);
  }

  /**
   * Execute a search operation with guardrail processing
   */
  async execute<T = unknown>(
    query: string,
    options?: {
      timeoutMs?: number;
      allowNetwork?: boolean;
      sessionId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SearchResult<T>> {
    const startTime = Date.now();
    this.lastError = undefined;

    try {
      // Execute the search (implementation-specific)
      const rawResult = await this.doSearch(query, {
        timeoutMs: options?.timeoutMs ?? this.config.timeoutMs,
        allowNetwork: options?.allowNetwork,
        sessionId: options?.sessionId,
      });

      // Process through guardrail
      const processed = this.guardrail.processResult({
        content: JSON.stringify(rawResult, null, 2),
        metadata: {
          operation: 'search',
          queryLength: query.length,
          resultSize: JSON.stringify(rawResult).length,
          ...(options?.metadata ?? {}),
        },
      });

      return {
        success: true,
        data: rawResult as T,
        processedContent: processed.processedContent,
        guardrailAction: processed.action,
        durationMs: Date.now() - startTime,
        bytesProcessed: processed.bytesProcessed,
        truncated: processed.wasTruncated,
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        data: null as T,
        processedContent: '',
        guardrailAction: 'none',
        durationMs: Date.now() - startTime,
        bytesProcessed: 0,
        truncated: false,
        error: this.lastError,
      };
    }
  }

  /**
   * Execute search with automatic retry
   */
  async executeWithRetry<T = unknown>(
    query: string,
    options?: {
      timeoutMs?: number;
      allowNetwork?: boolean;
      sessionId?: string;
      metadata?: Record<string, unknown>;
      maxRetries?: number;
      retryDelayMs?: number;
    }
  ): Promise<SearchResult<T>> {
    const maxRetries = options?.maxRetries ?? this.config.maxRetries;
    const retryDelayMs = options?.retryDelayMs ?? this.config.retryDelayMs;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.execute<T>(query, options);

      if (result.success) {
        return result;
      }

      lastError = result.error;

      if (attempt < maxRetries) {
        // Exponential backoff
        const delay = retryDelayMs * Math.pow(2, attempt);
        await this.sleep(delay);
      }
    }

    return {
      success: false,
      data: null as T,
      processedContent: '',
      guardrailAction: 'none',
      durationMs: 0,
      bytesProcessed: 0,
      truncated: false,
      error: lastError ?? new Error('Unknown failure'),
    };
  }

  /**
   * Execute a batch of search queries
   */
  async executeBatch<T = unknown>(
    queries: string[],
    options?: {
      timeoutMs?: number;
      allowNetwork?: boolean;
      sessionId?: string;
      concurrency?: number;
      metadata?: Record<string, unknown>;
    }
  ): Promise<SearchResult<T>[]> {
    const concurrency = options?.concurrency ?? 1;
    const results: SearchResult<T>[] = [];

    for (let i = 0; i < queries.length; i += concurrency) {
      const batch = queries.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(query =>
          this.execute<T>(query, {
            timeoutMs: options?.timeoutMs,
            allowNetwork: options?.allowNetwork,
            sessionId: options?.sessionId,
            metadata: { ...options?.metadata, batchIndex: i, queryIndex: queries.indexOf(query) },
          })
        )
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Get the last error encountered
   */
  getLastError(): Error | undefined {
    return this.lastError;
  }

  /**
   * Reset the proxy state
   */
  reset(): void {
    this.lastError = undefined;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SearchProxyConfig>): void {
    this.config = { ...this.config, ...config };
    this.guardrail = new Guardrail(this.config.guardrail);
  }

  /**
   * Core search implementation - to be overridden by subclasses
   */
  protected async doSearch(
    query: string,
    options?: { timeoutMs?: number; allowNetwork?: boolean; sessionId?: string }
  ): Promise<unknown> {
    throw new Error('doSearch() must be implemented by subclass');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ═══ Search Result ═══

export interface SearchResult<T> {
  /** Whether the search succeeded */
  success: boolean;
  /** The search result data */
  data: T | null;
  /** Guardrail-processed content */
  processedContent: string;
  /** The action taken by the guardrail */
  guardrailAction: 'none' | 'truncate' | 'summarize' | 'spill_to_file';
  /** Execution duration in ms */
  durationMs: number;
  /** Bytes processed */
  bytesProcessed: number;
  /** Whether content was truncated */
  truncated: boolean;
  /** Error if failed */
  error?: Error;
}

// ═══ Example Implementation ═══

/**
 * Example: HTTP Search Proxy
 * 
 * Implements search via HTTP requests with full guardrail integration.
 */
export class HttpSearchProxy extends SearchProxy {
  private baseUrl: string;
  private defaultHeaders: Record<string, string>;

  constructor(
    baseUrl: string,
    config?: Partial<SearchProxyConfig>,
    headers?: Record<string, string>
  ) {
    super(config);
    this.baseUrl = baseUrl;
    this.defaultHeaders = headers ?? {};
  }

  protected async doSearch(
    query: string,
    options?: { timeoutMs?: number; allowNetwork?: boolean; sessionId?: string }
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? this.config.timeoutMs);

    try {
      if (!options?.allowNetwork) {
        throw new Error('Network access disabled');
      }

      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.defaultHeaders,
        },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default {
  SearchProxy,
  HttpSearchProxy,
  DEFAULT_SEARCH_PROXY_CONFIG,
  types: {
    SearchResult,
    SearchProxyConfig,
  },
};

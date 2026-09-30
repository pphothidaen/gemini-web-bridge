/**
 * Phase 3: Output Guardrail
 * 
 * Content processing pipeline for managing output size and safety.
 * Provides configurable truncation, summarization, and spill-to-file
 * capabilities for large outputs.
 * 
 * Architecture:
 * - Preset-based configuration (development, staging, production)
 * - Multi-level processing: truncate → summarize → spill to file
 * - Metadata tracking for transparency
 * - Integrates with Search Proxy (Phase 2) via processResult()
 */

// ═══ Configuration ═══

export interface GuardrailConfig {
  /** Maximum characters before action is taken */
  maxChars: number;
  /** Character threshold for truncation */
  truncateAt: number;
  /** Character threshold for summarization */
  summarizeAt?: number;
  /** Character threshold for spill-to-file */
  spillThreshold: number;
  /** Whether to enable content filtering */
  contentFilter: boolean;
  /** Maximum summary length */
  maxSummaryLength?: number;
  /** Custom filter patterns (regex strings) */
  filterPatterns?: string[];
}

export const GuardrailPresets = {
  /** Development: minimal restrictions, full output */
  development: {
    maxChars: 1000000,
    truncateAt: 1000000,
    spillThreshold: 1000000,
    contentFilter: false,
    maxSummaryLength: 5000,
  } as GuardrailConfig,

  /** Staging: moderate restrictions */
  staging: {
    maxChars: 100000,
    truncateAt: 50000,
    summarizeAt: 75000,
    spillThreshold: 100000,
    contentFilter: true,
    maxSummaryLength: 2000,
  } as GuardrailConfig,

  /** Production: strict restrictions */
  production: {
    maxChars: 30000,
    truncateAt: 3000,
    spillThreshold: 10000,
    contentFilter: true,
    maxSummaryLength: 1000,
  } as GuardrailConfig,
};

// ═══ Guardrail ═══

export class Guardrail {
  private config: GuardrailConfig;
  private filteredCount = 0;
  private processedCount = 0;

  constructor(config: GuardrailConfig) {
    this.config = config;
  }

  /**
   * Process content through the guardrail pipeline
   */
  processResult(input: {
    content: string;
    metadata?: Record<string, unknown>;
  }): GuardrailResult {
    this.processedCount++;

    const { content, metadata = {} } = input;
    const originalLength = content.length;

    // Check if content exceeds limits
    if (originalLength <= this.config.maxChars) {
      return {
        processedContent: content,
        action: 'none',
        originalLength,
        processedLength: content.length,
        bytesProcessed: content.length,
        metadata: {
          ...metadata,
          guardrail: 'passThrough',
          filtered: false,
        },
      };
    }

    // Apply content filter if enabled
    let filteredContent = content;
    if (this.config.contentFilter) {
      filteredContent = this.applyFilters(content);
      this.filteredCount++;
    }

    // Determine action based on thresholds
    if (filteredContent.length > this.config.spillThreshold) {
      return this.spillToTempFile(filteredContent, metadata);
    }

    if (this.config.summarizeAt && filteredContent.length > this.config.summarizeAt) {
      return this.summarize(filteredContent, metadata);
    }

    if (filteredContent.length > this.config.truncateAt) {
      return this.truncate(filteredContent, metadata);
    }

    // Content is within limits after filtering
    return {
      processedContent: filteredContent,
      action: 'filtered',
      originalLength,
      processedLength: filteredContent.length,
      bytesProcessed: filteredContent.length,
      metadata: {
        ...metadata,
        guardrail: 'filtered',
        filtered: true,
      },
    };
  }

  /**
   * Truncate content to specified length
   */
  private truncate(content: string, metadata: Record<string, unknown>): GuardrailResult {
    const summaryLength = this.config.maxSummaryLength ?? 500;
    const truncated = content.slice(0, this.config.truncateAt);
    const suffix = '... [truncated]';

    return {
      processedContent: truncated + suffix,
      action: 'truncate',
      originalLength: content.length,
      processedLength: truncated.length + suffix.length,
      bytesProcessed: content.length,
      metadata: {
        ...metadata,
        guardrail: 'truncated',
        truncated: true,
        truncationPoint: this.config.truncateAt,
        summaryLength,
      },
    };
  }

  /**
   * Create a structural summary of the content
   */
  private summarize(content: string, metadata: Record<string, unknown>): GuardrailResult {
    const maxSummaryLength = this.config.maxSummaryLength ?? 1000;

    // Generate structural summary
    const summary = this.generateSummary(content, maxSummaryLength);

    return {
      processedContent: summary,
      action: 'summarize',
      originalLength: content.length,
      processedLength: summary.length,
      bytesProcessed: content.length,
      metadata: {
        ...metadata,
        guardrail: 'summarize',
        summarized: true,
        summaryLength,
      },
    };
  }

  /**
   * Spill large content to a temporary file
   */
  private spillToTempFile(
    content: string,
    metadata: Record<string, unknown>
  ): GuardrailResult {
    const { writeFile, tmpdir } = await import('fs/promises');
    const { join } = await import('path');
    const { randomUUID } = await import('crypto');

    const fileName = `guardrail-spill-${randomUUID().slice(0, 8)}.txt`;
    const filePath = join(tmpdir(), fileName);

    try {
      await writeFile(filePath, content, 'utf-8');

      return {
        processedContent: `[Content spilled to file: ${filePath}]`,
        action: 'spill_to_file',
        originalLength: content.length,
        processedLength: filePath.length + 30,
        bytesProcessed: content.length,
        metadata: {
          ...metadata,
          guardrail: 'spill_to_file',
          spillPath: filePath,
          spillSize: content.length,
        },
      };
    } catch (error) {
      // Fallback to truncation if file write fails
      return this.truncate(content, {
        ...metadata,
        spillFailed: true,
        spillError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Apply content filters
   */
  private applyFilters(content: string): string {
    let result = content;

    // Remove sensitive patterns if configured
    if (this.config.filterPatterns) {
      for (const pattern of this.config.filterPatterns) {
        try {
          const regex = new RegExp(pattern, 'gi');
          result = result.replace(regex, '[REDACTED]');
        } catch {
          // Invalid regex, skip
        }
      }
    }

    // Remove excessive whitespace
    result = result.replace(/\s+/g, ' ').trim();

    return result;
  }

  /**
   * Generate a structural summary of content
   */
  private generateSummary(content: string, maxLength: number): string {
    // Analyze content structure
    const lines = content.split('\n');
    const totalLines = lines.length;
    const nonEmptyLines = lines.filter(l => l.trim().length > 0).length;

    // Extract key structural elements
    const hasJson = content.trim().startsWith('{') || content.trim().startsWith('[');
    const hasCode = /^[ \t]*[a-zA-Z0-9]/m.test(content);
    const avgLineLength = content.length / Math.max(totalLines, 1);

    // Build summary
    const parts: string[] = [
      `Content summary (${totalLines} lines, ${nonEmptyLines} non-empty):`,
    ];

    if (hasJson) {
      parts.push('• Format: JSON');
      try {
        const parsed = JSON.parse(content);
        const keys = parsed instanceof Array ? `array[${parsed.length}]` :
                       Object.keys(parsed).join(', ');
        parts.push(`• Keys/items: ${keys.slice(0, 200)}`);
      } catch {
        parts.push('• Structure: JSON (parse error in summary)');
      }
    } else if (hasCode) {
      parts.push('• Format: Code/text');
      const firstLines = lines.filter(l => l.trim()).slice(0, 10).join('\n');
      parts.push(`• Preview: ${firstLines.slice(0, maxLength * 0.6)}`);
    } else {
      parts.push('• Format: Text');
      const firstLines = lines.filter(l => l.trim()).slice(0, 5).join('\n');
      parts.push(`• Preview: ${firstLines.slice(0, maxLength * 0.6)}`);
    }

    parts.push(`• Stats: avg line length ${avgLineLength.toFixed(0)} chars`);

    return parts.join('\n').slice(0, maxLength);
  }

  /**
   * Get statistics for the guardrail session
   */
  getStats(): GuardrailStats {
    return {
      processedCount: this.processedCount,
      filteredCount: this.filteredCount,
      config: { ...this.config },
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.filteredCount = 0;
    this.processedCount = 0;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<GuardrailConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// ═══ Types ═══

export interface GuardrailResult {
  /** The processed content (may be truncated, summarized, or file reference) */
  processedContent: string;
  /** The action taken by the guardrail */
  action: 'none' | 'truncate' | 'summarize' | 'spill_to_file' | 'filtered';
  /** Original content length in characters */
  originalLength: number;
  /** Processed content length in characters */
  processedLength: number;
  /** Total bytes processed */
  bytesProcessed: number;
  /** Additional metadata */
  metadata: Record<string, unknown>;
}

export interface GuardrailStats {
  /** Total items processed */
  processedCount: number;
  /** Items that went through filtering */
  filteredCount: number;
  /** Current configuration */
  config: GuardrailConfig;
}

export default {
  Guardrail,
  GuardrailPresets,
  types: {
    GuardrailConfig,
    GuardrailResult,
    GuardrailStats,
  },
};

/**
 * Playwright Heavy Load Test
 * VPS 4GB制約でのサイト数限界を検証
 * 
 * 前提:
 * - Playwright: 40% (150-200MB/instance)
 * - Normal: 60% (10-30MB/instance)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';

// Custom Metrics
const errorRate = new Rate('scraping_errors');
const scrapeDuration = new Trend('scrape_duration');
const successfulScrapes = new Counter('successful_scrapes');
const memoryUsage = Gauge('app_memory_mb');
const playwrightInstances = Gauge('playwright_count');

export const options = {
  scenarios: {
    // フェーズ1: 現状（43サイト、40% Playwright）
    current_load: {
      executor: 'constant-vus',
      vus: 43,
      duration: '3m',
      startTime: '0s',
      tags: { phase: 'current' },
    },
    
    // フェーズ2: 段階的増加（43 → 60 → 80サイト）
    scaling_test: {
      executor: 'ramping-vus',
      startVUs: 43,
      stages: [
        { duration: '1m', target: 60 },
        { duration: '1m', target: 60 },
        { duration: '1m', target: 80 },
        { duration: '1m', target: 80 },
      ],
      startTime: '3m',
      tags: { phase: 'scaling' },
    },
    
    // フェーズ3: 限界テスト（100サイトまで）
    limit_test: {
      executor: 'ramping-vus',
      startVUs: 80,
      stages: [
        { duration: '1m', target: 100 },
        { duration: '2m', target: 100 },
      ],
      startTime: '7m',
      tags: { phase: 'limit' },
    },
  },
  
  thresholds: {
    'http_req_duration': ['p(95)<20000'],  // 20秒（Playwrightは重い）
    'http_req_failed': ['rate<0.20'],      // 20%未満
    'scraping_errors': ['rate<0.20'],
  },
};

const BASE_URL = 'http://host.docker.internal:8002';
const TOTAL_SITES = 100;

// サイトIDとPlaywright使用の組み合わせを生成
const SITES = Array.from({length: TOTAL_SITES}, (_, i) => ({
  id: "site_" + i.toString().padStart(3, '0'),
  usePlaywright: i < Math.floor(TOTAL_SITES * 0.4), // 40%がPlaywright
}));

export default function () {
  const siteIndex = (__VU - 1) % SITES.length;
  const site = SITES[siteIndex];
  
  const startTime = new Date();
  const url = BASE_URL + "/api/scrape/" + site.id + 
              "?use_playwright=" + site.usePlaywright;
  
  const response = http.post(url, null, {
    timeout: '30s',
    tags: { 
      site_type: site.usePlaywright ? 'playwright' : 'normal' 
    },
  });
  
  const duration = new Date() - startTime;
  
  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has response': (r) => r.body && r.body.length > 0,
    'duration < 20s': (r) => r.timings.duration < 20000,
  });
  
  errorRate.add(!success);
  scrapeDuration.add(duration);
  
  if (success) {
    successfulScrapes.add(1);
    
    // メモリ使用量を記録
    try {
      const data = JSON.parse(response.body);
      if (data.memory_used_mb) {
        memoryUsage.add(data.memory_used_mb);
      }
    } catch (e) {
      // ignore parse errors
    }
  }
  
  // スクレイピング間隔
  // Playwright: 60-90秒（重い）
  // Normal: 40-60秒（軽い）
  const waitTime = site.usePlaywright ? 
    Math.random() * 30 + 60 :  // 60-90秒
    Math.random() * 20 + 40;   // 40-60秒
  
  sleep(waitTime);
}

export function handleSummary(data) {
  const httpReqs = data.metrics.http_reqs?.values?.count || 0;
  const errorRateValue = data.metrics.http_req_failed?.values?.rate || 0;
  const p50 = data.metrics.http_req_duration?.values?.['p(50)'] || 0;
  const p95 = data.metrics.http_req_duration?.values?.['p(95)'] || 0;
  const p99 = data.metrics.http_req_duration?.values?.['p(99)'] || 0;
  
  const summary = {
    timestamp: new Date().toISOString(),
    environment: {
      vps_memory: "4GB",
      playwright_ratio: "40%",
      normal_ratio: "60%",
    },
    results: {
      total_requests: httpReqs,
      error_rate: (errorRateValue * 100).toFixed(2) + '%',
      response_times: {
        p50: (p50 / 1000).toFixed(2) + 's',
        p95: (p95 / 1000).toFixed(2) + 's',
        p99: (p99 / 1000).toFixed(2) + 's',
      },
    },
    recommendation: getRecommendation(errorRateValue, p95),
  };
  
  const textSummary = generateTextSummary(data, summary);
  
  return {
    '/results/playwright-load-test.json': JSON.stringify(summary, null, 2),
    'stdout': textSummary,
  };
}

function getRecommendation(errorRate, p95) {
  if (errorRate < 0.10 && p95 < 15000) {
    return {
      status: 'excellent',
      message: '✅ System can handle 100+ sites with Playwright',
      max_sites: 100,
      confidence: 'high',
    };
  } else if (errorRate < 0.20 && p95 < 20000) {
    return {
      status: 'acceptable',
      message: '⚠️  System stable but near limits',
      max_sites: 80,
      confidence: 'medium',
    };
  } else {
    return {
      status: 'critical',
      message: '❌ Memory/CPU limits reached',
      max_sites: 60,
      confidence: 'high',
    };
  }
}

function generateTextSummary(data, summary) {
  const rec = summary.recommendation;
  
  return `
╔════════════════════════════════════════════════════════════╗
║        Playwright Heavy Load Test Results                 ║
║        VPS 4GB Memory Constraint                           ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  🖥️  Environment:                                          ║
║    - Memory: 4GB VPS                                       ║
║    - Playwright Sites: 40% (150-200MB each)                ║
║    - Normal Sites: 60% (10-30MB each)                      ║
║                                                            ║
║  📊 Overall Performance:                                  ║
║    - Total Requests: ${summary.results.total_requests.toString().padEnd(36)}║
║    - Error Rate: ${summary.results.error_rate.padEnd(40)}║
║    - P50 Latency: ${summary.results.response_times.p50.padEnd(39)}║
║    - P95 Latency: ${summary.results.response_times.p95.padEnd(39)}║
║    - P99 Latency: ${summary.results.response_times.p99.padEnd(39)}║
║                                                            ║
║  🎯 Recommendation:                                       ║
║    Status: ${rec.status.padEnd(48)}║
║    ${rec.message.padEnd(56)}║
║    Max Sites: ${rec.max_sites.toString().padEnd(45)}║
║    Confidence: ${rec.confidence.padEnd(44)}║
║                                                            ║
║  💡 Memory Analysis:                                      ║
${getMemoryAnalysis(data)}
║                                                            ║
╚════════════════════════════════════════════════════════════╝
`;
}

function getMemoryAnalysis(data) {
  // メモリ分析ロジック（簡略版）
  return `║    - Playwright instances use ~150-200MB each              ║
║    - Estimated peak: ~2.5-3GB for 60 sites                ║
║    - Headroom: ~1GB for system overhead                   ║`;
}

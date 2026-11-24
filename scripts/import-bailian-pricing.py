#!/usr/bin/env python3
"""从百炼官方 HTML 快照生成四家族国内实时推理费率。"""

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup

SOURCE_PATH = Path('/tmp/bailian-model-pricing.html')
OUTPUT_PATH = Path(__file__).resolve().parents[1] / 'data' / 'bailian-model-prices.json'
SOURCE_URL = 'https://help.aliyun.com/zh/model-studio/model-pricing'
INTERNATIONAL_MARKERS = ('国际', '美国', '全球', '欧盟', '中国香港', '新加坡', '德国', '日本', '弗吉尼亚', '法兰克福', '东京')
FAMILY_PREFIXES = ('kimi', 'qwen', 'deepseek', 'glm')
EXCLUDED_MODEL_MARKERS = ('omni', '-vl', 'audio', 'image', 'ocr', 'tts', 'asr', 'embedding', 'rerank')
REQUIRED_MODELS = {
    'kimi-k3.1-pro', 'deepseek-v4.1-flash-1017', 'glm-5.1',
    'qwen4-max', 'qwen3.7-plus', 'qwen-plus-2025-12-01'
}
# GLM 缓存命中费率不在价格表内，官方公布于「上下文缓存」页（华北2北京属“其他地域”）：
# glm-5.3/5.3-prime/5.2/5.2-fast-preview 为输入单价的 25%，glm-5.1/glm-5 为 20%。
# 来源：https://help.aliyun.com/zh/model-studio/context-cache
GLM_CACHE_RATIOS = {
    'glm-5.3': 0.25, 'glm-5.3-prime': 0.25, 'glm-5.2': 0.25,
    'glm-5.2-fast-preview': 0.25, 'glm-5.1': 0.20, 'glm-5': 0.20,
}


def apply_glm_cache_rates(prices):
    """按官方比例把 GLM 缓存命中价从 unknown 补为输入单价的固定折扣。"""
    for model, ratio in GLM_CACHE_RATIOS.items():
        version = prices.get(model)
        if not version:
            continue
        tiers = version.get('inputTiers')
        if tiers:
            for tier in tiers:
                tier['cacheRead'] = round(tier['input'] * ratio, 4)
            version['cacheRead'] = tiers[0]['cacheRead']
        elif isinstance(version.get('input'), (int, float)):
            version['cacheRead'] = round(version['input'] * ratio, 4)


def expand_rows(table):
    """将 rowspan 单元格补到后续行，避免模型或档位被吞掉。"""
    rows = []
    carry = {}
    for row in table.find_all('tr'):
        cells = []
        for cell in row.find_all(['td', 'th'], recursive=False):
            text = cell.get_text(' ', strip=True)
            rowspan = int(cell.get('rowspan', 1))
            colspan = int(cell.get('colspan', 1))
            cells.append((text, rowspan, colspan))
        width = max(len(cells), max(carry.keys(), default=-1) + 1)
        expanded = []
        for index in range(width):
            if index < len(cells):
                text, rowspan, colspan = cells[index]
                expanded.append(text)
                expanded.extend([''] * (colspan - 1))
                if rowspan > 1:
                    carry[index] = (text, rowspan - 1, colspan)
                else:
                    carry.pop(index, None)
            elif index in carry:
                text, rowspan, colspan = carry[index]
                expanded.append(text)
                expanded.extend([''] * (colspan - 1))
                if rowspan > 1:
                    carry[index] = (text, rowspan - 1, colspan)
                else:
                    carry.pop(index, None)
            else:
                expanded.append('')
        if any(expanded):
            rows.append(expanded)
    return rows


def parse_number(text):
    match = re.search(r'(\d+(?:\.\d+)?)\s*元', text)
    return float(match.group(1)) if match else None


def parse_price_cell(text):
    discount = re.search(r'原价\s*(\d+(?:\.\d+)?)\s*元.*?限时\s*(\d+(?:\.\d+)?)\s*折', text)
    if discount:
        return float(discount.group(1)) * float(discount.group(2)) / 10
    return parse_number(text)


def parse_tier(text):
    matches = list(re.finditer(r'(\d+(?:\.\d+)?)([KM])', text, re.IGNORECASE))
    if not matches:
        return None
    match = matches[-1]
    value = float(match.group(1))
    return int(value * (1000 if match.group(2).upper() == 'K' else 1_000_000))


def parse_peak(text):
    match = re.search(r'忙时\s*(\d+(?:\.\d+)?)\s*元.*?闲时\s*(\d+(?:\.\d+)?)\s*元', text)
    return (float(match.group(1)), float(match.group(2))) if match else (None, None)


def is_free_model(text):
    return '限时免费' in text or '目前仅供免费体验' in text


def version_base(cache_read='unknown', cache_write=None):
    version = {'effectiveFrom': '2026-11-20', 'cacheRead': cache_read}
    if cache_write is not None:
        version['cacheWrite'] = cache_write
    return version


def parse_row(cells, previous_model=None):
    if not cells:
        return None, None
    # 后续阶梯行首只有 Token 范围，继承上一行的模型 ID。
    if previous_model and parse_tier(cells[0]) is not None:
        cells = [previous_model] + cells
    model = re.match(r'^([A-Za-z][A-Za-z0-9._:/-]*)', cells[0])
    if not model:
        return None, None
    model = model.group(1)
    if not model.lower().startswith(FAMILY_PREFIXES):
        return None, None
    if any(marker in model.lower() for marker in EXCLUDED_MODEL_MARKERS):
        return None, None
    text = ' '.join(cells)

    if is_free_model(text):
        return model, {
            'effectiveFrom': '2026-11-20', 'input': 0, 'output': 0,
            'cacheRead': 0, 'cacheWrite': 0,
        }

    tier_index = next((index for index, cell in enumerate(cells) if parse_tier(cell) is not None), None)
    price_cells = cells[tier_index + 1 if tier_index is not None else 1:]
    values = [parse_price_cell(cell) for cell in price_cells]
    values = [value for value in values if value is not None]
    if len(values) < 2:
        return None, None

    input_price, output_price = values[0], values[1]
    reasoning_output = values[2] if len(values) > 2 else output_price
    cache_read_match = re.search(r'缓存命中输入：\s*(\d+(?:\.\d+)?)\s*元', text)
    cache_read = float(cache_read_match.group(1)) if cache_read_match else 'unknown'
    if model == 'qwen4-max':
        cache_read = 0.5

    peak_input, off_input = parse_peak(text)
    if peak_input is not None:
        peak_output, off_output = parse_peak(cells[-2]) if len(cells) >= 2 else (output_price, reasoning_output)
        if peak_output is None:
            peak_output, off_output = output_price, reasoning_output
        version = version_base(cache_read, peak_input)
        version.update({
            'input': peak_input,
            'output': peak_output,
            'peak': {'input': peak_input, 'output': peak_output, 'cacheWrite': peak_input},
            'offPeak': {'input': off_input, 'output': off_output, 'cacheWrite': off_input},
            'offPeakStart': '22:00',
            'offPeakEnd': '08:00',
        })
        return model, version

    if tier_index is not None:
        tier = {
            'maxInputTokens': parse_tier(cells[tier_index]),
            'input': input_price,
            'output': output_price,
            'cacheWrite': input_price,
        }
        if reasoning_output != output_price:
            tier['reasoningOutput'] = reasoning_output
        version = version_base(cache_read)
        version['inputTiers'] = [tier]
        return model, version

    version = version_base(cache_read, input_price)
    version.update({'input': input_price, 'output': output_price})
    if reasoning_output != output_price:
        version['reasoningOutput'] = reasoning_output
    return model, version


def parse_document(html):
    soup = BeautifulSoup(html, 'html.parser')
    prices = {}
    for table in soup.find_all('table'):
        text = table.get_text(' ', strip=True)
        if any(marker in text for marker in INTERNATIONAL_MARKERS):
            continue
        previous_model = None
        for cells in expand_rows(table):
            model, version = parse_row(cells, previous_model)
            if model:
                previous_model = model
            if not model:
                continue
            # 同一正式模型可能有多个输入档，按行顺序保留。
            if model in prices and 'inputTiers' in version:
                prices[model].setdefault('inputTiers', []).extend(version.pop('inputTiers'))
            elif model in prices and 'inputTiers' in prices[model] and 'inputTiers' not in version:
                prices[model]['inputTiers'].append({
                    'maxInputTokens': 1_000_000,
                    'input': version['input'],
                    'output': version['output'],
                    'cacheWrite': version['cacheWrite'],
                })
            else:
                prices[model] = version
    return prices


def validate_candidate(model_prices):
    if len(model_prices) < 50:
        raise ValueError(f'模型数量异常：仅 {len(model_prices)} 个')
    missing = REQUIRED_MODELS - model_prices.keys()
    if missing:
        raise ValueError(f'缺少关键模型：{sorted(missing)}')
    for model, version in model_prices.items():
        tiers = version.get('inputTiers', [])
        previous = 0
        for tier in tiers:
            if tier['maxInputTokens'] <= previous:
                raise ValueError(f'{model} 阶梯不连续')
            previous = tier['maxInputTokens']
            for field in ('input', 'output', 'cacheWrite'):
                if not isinstance(tier[field], (int, float)) or tier[field] < 0:
                    raise ValueError(f'{model} 非法价格 {field}')
        for field in ('input', 'output', 'cacheWrite'):
            if field in version and not isinstance(version[field], (int, float)):
                raise ValueError(f'{model} 非法价格 {field}')
        if version.get('peak') and not version.get('offPeak'):
            raise ValueError(f'{model} 峰谷配置不完整')
    if model_prices['kimi-k3.1-pro']['cacheRead'] != 1.3:
        raise ValueError('Kimi 缓存命中价格错误')
    if model_prices['qwen4-max']['cacheRead'] != 0.5:
        raise ValueError('qwen4-max 缓存命中价格错误')
    deepseek = model_prices['deepseek-v4.1-flash-1017']
    if deepseek['cacheRead'] != 0.04 or deepseek['peak']['cacheRead'] != 0.04 or deepseek['offPeak']['cacheRead'] != 0.02:
        raise ValueError('DeepSeek 1017 峰谷缓存命中价格错误')


def main():
    raw = SOURCE_PATH.read_bytes()
    model_prices = parse_document(raw.decode('utf-8'))
    if 'kimi-k3.1-pro' in model_prices:
        model_prices['kimi-k3.1-pro'] = {
            'effectiveFrom': '2026-11-19', 'input': 13, 'output': 68,
            'cacheRead': 1.3, 'cacheWrite': 13,
        }
    if 'deepseek-v4.1-flash-1017' in model_prices:
        # 该型号缓存命中也分峰谷，忙时 0.04、闲时 0.02 元/百万 Token。
        deepseek = model_prices['deepseek-v4.1-flash-1017']
        deepseek['cacheRead'] = 0.04
        deepseek.setdefault('peak', {})['cacheRead'] = 0.04
        deepseek.setdefault('offPeak', {})['cacheRead'] = 0.02
    validate_candidate(model_prices)
    apply_glm_cache_rates(model_prices)
    if model_prices['glm-5.3']['cacheRead'] != 2:
        raise ValueError('glm-5.3 缓存命中价格错误（应为输入价 8 元的 25%）')
    model_prices = {model: [version] for model, version in model_prices.items()}
    payload = {
        'sourceUrl': SOURCE_URL,
        'retrievedAt': datetime.now(timezone.utc).date().isoformat(),
        'sourceSha256': hashlib.sha256(raw).hexdigest(),
        'notes': [
            '仅华北2（北京）实时推理价格，不含 Batch 和国际价格。',
            '限时折扣与免费模型按当前官方价格计入，优惠资格与结束日以控制台为准。',
            'GLM 缓存命中价按官方上下文缓存页比例计入（北京：5.3 系列 25%、5.1/5 20%）。',
            '其余未公开缓存命中费率标记为 unknown；含缓存命中的调用不估价（标记缺价），不猜价。',
        ],
        'families': {
            family: sum(model.lower().startswith(family) for model in model_prices)
            for family in FAMILY_PREFIXES
        },
        'modelPrices': dict(sorted(model_prices.items())),
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'已生成 {len(model_prices)} 个模型费率：{OUTPUT_PATH}')


if __name__ == '__main__':
    main()

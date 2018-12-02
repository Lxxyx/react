/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import MAX_SIGNED_31_BIT_INT from './maxSigned31BitInt';

export type ExpirationTime = number;

export const NoWork = 0;
export const Never = 1;
export const Sync = MAX_SIGNED_31_BIT_INT;

// 1 expiration time 代表10 ms
const UNIT_SIZE = 10;
const MAGIC_NUMBER_OFFSET = MAX_SIGNED_31_BIT_INT - 1;

// 1 unit of expiration time represents 10ms.
// 在 msToExpirationTime 的调用中，ms 的值是 performance.now 返回的时间，不可能低于 10 ms
// 而普通调用则返回的是 （MAX_SIGNED_31_BIT_INT -1） - Math.floor(performance.now() / 10)
// 而 Sync 的优先级最高，是 MAX_SIGNED_31_BIT_INT
// 从 React 的 PR 可以看出，ExpirationTime 代表优先级，ExpirationTime 越大则优先级越高
// 则最后优先级的排序为：Sync -> 调用 msToExpirationTime 获得的 ExpirationTime -> Never -> NoWork
export function msToExpirationTime(ms: number): ExpirationTime {
  // 这句注释我总觉得是不是他们没有删掉……因为真的没有看出和 NoWork 有啥联系……
  // Always add an offset so that we don't clash with the magic number for NoWork.
  return MAGIC_NUMBER_OFFSET - ((ms / UNIT_SIZE) | 0);
}

export function expirationTimeToMs(expirationTime: ExpirationTime): number {
  return (MAGIC_NUMBER_OFFSET - expirationTime) * UNIT_SIZE;
}

// 按给定的精度值，向上取整，如：
//    ceiling(999, 25) = 1000
//    ceiling(1000, 25) = 1025
//    ceiling(1024, 25) = 1025
//    ceiling(1026, 25) = 1050
function ceiling(num: number, precision: number): number {
  return (((num / precision) | 0) + 1) * precision;
}

// 当使用 computeAsyncExpiration 时，
// expirationInMs 为 5000，bucketSizeMs 为 250
// 在执行 ceiling 向上取整时，有几个步骤是需要推敲的：
//    1. MAGIC_NUMBER_OFFSET - currentTime = MAGIC_NUMBER_OFFSET - (MAGIC_NUMBER_OFFSET - ((ms / UNIT_SIZE) | 0)) = (ms / UNIT_SIZE) | 0) = 向上取整的 ms / UNIT_SIZE
//    2. MAGIC_NUMBER_OFFSET - currentTime + expirationInMs / UNIT_SIZE = ms / UNIT_SIZE + 5000 / UNIT_SIZE = (msUnit + 500) Unit
//    3. (bucketSizeMs / UNIT_SIZE) = 250 / 10 = 25
// 按 25 个 Unit 向上取整
// 则最后的返回值为：MAGIC_NUMBER_OFFSET - ceiling(msUnit + 500, 25)

// 而当使用 computeInteractiveExpiration，优先级更高
// expirationInMs 为 150，bucketSizeMs 为 10
// 最后的结果为 MAGIC_NUMBER_OFFSET - ceiling(msUnit + 15, 10)
// 不难看出，在 computeInteractiveExpiration 下，返回的数字是大于 computeAsyncExpiration 的。
// 也就是说 computeInteractiveExpiration 返回的 ExpirationTime，优先级更高。
function computeExpirationBucket(
  currentTime,
  expirationInMs,
  bucketSizeMs,
): ExpirationTime {
  return (
    MAGIC_NUMBER_OFFSET -
    ceiling(
      MAGIC_NUMBER_OFFSET - currentTime + expirationInMs / UNIT_SIZE,
      bucketSizeMs / UNIT_SIZE,
    )
  );
}

export const LOW_PRIORITY_EXPIRATION = 5000;
export const LOW_PRIORITY_BATCH_SIZE = 250;

// computeAsyncExpiration 是基于低优先级做计算的
export function computeAsyncExpiration(
  currentTime: ExpirationTime,
): ExpirationTime {
  return computeExpirationBucket(
    currentTime,
    LOW_PRIORITY_EXPIRATION,
    LOW_PRIORITY_BATCH_SIZE,
  );
}

// We intentionally set a higher expiration time for interactive updates in
// dev than in production.
//
// If the main thread is being blocked so long that you hit the expiration,
// it's a problem that could be solved with better scheduling.
//
// People will be more likely to notice this and fix it with the long
// expiration time in development.
//
// In production we opt for better UX at the risk of masking scheduling
// problems, by expiring fast.
export const HIGH_PRIORITY_EXPIRATION = __DEV__ ? 500 : 150;
export const HIGH_PRIORITY_BATCH_SIZE = 100;

export function computeInteractiveExpiration(currentTime: ExpirationTime) {
  return computeExpirationBucket(
    currentTime,
    HIGH_PRIORITY_EXPIRATION,
    HIGH_PRIORITY_BATCH_SIZE,
  );
}

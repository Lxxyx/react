/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-var */

// TODO: Use symbols?
var ImmediatePriority = 1;
var UserBlockingPriority = 2;
var NormalPriority = 3;
var LowPriority = 4;
var IdlePriority = 5;

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Times out immediately
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// Eventually times out
var USER_BLOCKING_PRIORITY = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
var LOW_PRIORITY_TIMEOUT = 10000;
// Never times out
var IDLE_PRIORITY = maxSigned31BitInt;

// Callbacks are stored as a circular, doubly linked list.
var firstCallbackNode = null;

var currentDidTimeout = false;
var currentPriorityLevel = NormalPriority;
var currentEventStartTime = -1;
var currentExpirationTime = -1;

// This is set when a callback is being executed, to prevent re-entrancy.
var isExecutingCallback = false;

var isHostCallbackScheduled = false;

var hasNativePerformanceNow =
  typeof performance === 'object' && typeof performance.now === 'function';

function ensureHostCallbackIsScheduled() {
  // 如果正在执行回调，就不调度工作了
  // isExecutingCallback 作用暂时不明确
  if (isExecutingCallback) {
    // Don't schedule work yet; wait until the next time we yield.
    return;
  }
  // Schedule the host callback using the earliest expiration in the list.
  // 取出优先级最高的节点，并开始工作
  var expirationTime = firstCallbackNode.expirationTime;
  // 如果之前没有正在等待执行的 Callback，则将 isHostCallbackScheduled 设置为 True，代表当前有高优先级工作等待执行
  if (!isHostCallbackScheduled) {
    isHostCallbackScheduled = true;
  } else {
    // 进入 Else 分支则表明之前已经安排了一个高优先级的工作
    // 但是本次的优先级要高于先前安排的工作
    // 因此取消之前安排的回调，将回调设置为本次获取到的优先级最高的节点
    // 也就是所谓的插队！！！
    // Cancel the existing host callback.
    cancelHostCallback();
  }
  // 设置回调，准备工作
  requestHostCallback(flushWork, expirationTime);
}

// flushFirstCallback 执行传入的回调 ，并更新 firstCallbackNode
function flushFirstCallback() {
  // 设置当前工作的节点为链表首节点
  var flushedNode = firstCallbackNode;

  // 将当前的链表首节点从链表中移除，需要注意的是这儿是在回调执行前做的移除工作。
  // 据注释可得知这是为了保持链表在回调执行成功或失败情况下的一致性。
  // 如果是在回调结束后处理链表，那么加入 callback 抛出异常，还需要对链表做特殊处理。
  // 我个人觉得回调被执行后，该节点就不应该被保留，从而避免无限错误的 BUG ，具体出错的情况留给调用方取处理。
  // Remove the node from the list before calling the callback. That way the
  // list is in a consistent state even if the callback throws.
  var next = firstCallbackNode.next;
  // 假如只有一个节点
  if (firstCallbackNode === next) {
    // This is the last callback in the list.
    firstCallbackNode = null;
    next = null;
  } else {
    // 多个节点的情况下
    var lastCallbackNode = firstCallbackNode.previous;
    firstCallbackNode = lastCallbackNode.next = next;
    next.previous = lastCallbackNode;
  }

  // 断开与链表节点的连接
  flushedNode.next = flushedNode.previous = null;

  // Now it's safe to call the callback.
  // 保存节点的各项信息
  var callback = flushedNode.callback;
  var expirationTime = flushedNode.expirationTime;
  var priorityLevel = flushedNode.priorityLevel;
  var previousPriorityLevel = currentPriorityLevel;
  var previousExpirationTime = currentExpirationTime;

  // 将currentPriorityLevel/currentExpirationTime 设置为当前任务的优先级与时间。
  // 原因是，在执行回调时，有可能会在回调内部调用 unscheduled_callback ，而我们希望在回调里调用而产生的链表节点，与执行中的回调拥有相同的优先级？
  currentPriorityLevel = priorityLevel;
  currentExpirationTime = expirationTime;
  // 如果调用回调，返回值是一个函数的话，这儿需要将返回值视为一次新的 unscheduled_callback 调用（尽管没有这么做），作为新的节点插入链表
  var continuationCallback;
  try {
    continuationCallback = callback();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentExpirationTime = previousExpirationTime;
  }

  // 下面和 unscheduled_callback 的作用一样，将新的节点插入链表。
  // @TODO 我认为可以提个 PR，专门用于插入新的节点至链表
  // A callback may return a continuation. The continuation should be scheduled
  // with the same priority and expiration as the just-finished callback.
  if (typeof continuationCallback === 'function') {
    var continuationNode: CallbackNode = {
      callback: continuationCallback,
      priorityLevel,
      expirationTime,
      next: null,
      previous: null,
    };

    // Insert the new callback into the list, sorted by its expiration. This is
    // almost the same as the code in `scheduleCallback`, except the callback
    // is inserted into the list *before* callbacks of equal expiration instead
    // of after.
    if (firstCallbackNode === null) {
      // This is the first callback in the list.
      firstCallbackNode = continuationNode.next = continuationNode.previous = continuationNode;
    } else {
      var nextAfterContinuation = null;
      var node = firstCallbackNode;
      do {
        if (node.expirationTime >= expirationTime) {
          // This callback expires at or after the continuation. We will insert
          // the continuation *before* this callback.
          nextAfterContinuation = node;
          break;
        }
        node = node.next;
      } while (node !== firstCallbackNode);

      if (nextAfterContinuation === null) {
        // No equal or lower priority callback was found, which means the new
        // callback is the lowest priority callback in the list.
        nextAfterContinuation = firstCallbackNode;
      } else if (nextAfterContinuation === firstCallbackNode) {
        // The new callback is the highest priority callback in the list.
        firstCallbackNode = continuationNode;
        ensureHostCallbackIsScheduled();
      }

      var previous = nextAfterContinuation.previous;
      previous.next = nextAfterContinuation.previous = continuationNode;
      continuationNode.next = nextAfterContinuation;
      continuationNode.previous = previous;
    }
  }
}

// flushImmediateWork 的调用发生于 flushWork 的末尾
// 处理完当前帧的高优先级任务或过期任务后。会确保再处理掉所有 priorityLevel 为 ImmediatePriority 的
// 也就是说 ImmediatePriority 代表着这个函数一定会在本帧被执行掉
// 而这个函数的执行需要满足一个要求：currentEventStartTime === -1
// currentEventStartTime !== -1 意味着 unstable_runWithPriority 被执行，不过目前 unstable_runWithPriority 这个函数看起来还不是很完善，也没有其他的package调用它。
// 暂时忽略
function flushImmediateWork() {
  if (
    // Confirm we've exited the outer most event handler
    currentEventStartTime === -1 &&
    firstCallbackNode !== null &&
    firstCallbackNode.priorityLevel === ImmediatePriority
  ) {
    isExecutingCallback = true;
    try {
      do {
        flushFirstCallback();
      } while (
        // Keep flushing until there are no more immediate callbacks
      firstCallbackNode !== null &&
      firstCallbackNode.priorityLevel === ImmediatePriority
        );
    } finally {
      isExecutingCallback = false;
      if (firstCallbackNode !== null) {
        // There's still work remaining. Request another callback.
        ensureHostCallbackIsScheduled();
      } else {
        isHostCallbackScheduled = false;
      }
    }
  }
}

// flush 意思应该为执行，则该函数意思是执行工作
function flushWork(didTimeout) {
  // 设置 isExecutingCallback 为 True
  isExecutingCallback = true;
  // 记录上一次的超时情况，并将本次传入的 didTimeout 作为本次执行是否是在超时情况下的证据
  // 本处的超时指的是：当前帧超时 & 当前任务超时 情况下的调度
  const previousDidTimeout = currentDidTimeout;
  currentDidTimeout = didTimeout;
  try {
    // 如果是在超时情况下执行，则一次性执行完所有超时的任务
    // 同时，执行任务是耗时的，可能会导致后续部分任务也跟着超时。
    // 所以在内部的逻辑中，每一次 do while 执行 flushFirstCallback 的过程，都会把本次所有过期的任务给处理掉。
    // 而如果 firstCallbackNode 不为 null 的话，则重新请求当前时间，继续遍历链表，查看是否有过期任务需要执行。
    // 这样做的好处在于可以确保在一次 flushWork 中可以清除掉所有的过期任务，即使执行任务本身会耗费时间。
    // 而且 getCurrentTime 函数将被调用的尽可能少。
    if (didTimeout) {
      // Flush all the expired callbacks without yielding.
      while (firstCallbackNode !== null) {
        // Read the current time. Flush all the callbacks that expire at or
        // earlier than that time. Then read the current time again and repeat.
        // This optimizes for as few performance.now calls as possible.
        var currentTime = getCurrentTime();
        if (firstCallbackNode.expirationTime <= currentTime) {
          do {
            flushFirstCallback();
          } while (
            firstCallbackNode !== null &&
            firstCallbackNode.expirationTime <= currentTime
            );
          continue;
        }
        break;
      }
    } else {
      // 是非超时情况下执行，则会通过调用 shouldYieldToHost（中文名应该叫：应该把控制权归还给浏览器吗？），确保在当前帧过期前，调用任务。
      // Keep flushing callbacks until we run out of time in the frame.
      if (firstCallbackNode !== null) {
        do {
          flushFirstCallback();
        } while (firstCallbackNode !== null && !shouldYieldToHost());
      }
    }
  } finally {
    // 将 isExecutingCallback 设置为 false
    isExecutingCallback = false;
    // 记录过期时间
    currentDidTimeout = previousDidTimeout;
    if (firstCallbackNode !== null) {
      // 证明还有任务，还是需要执行
      // There's still work remaining. Request another callback.
      ensureHostCallbackIsScheduled();
    } else {
      // 没有任务需要执行了
      isHostCallbackScheduled = false;
    }
    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_runWithPriority(priorityLevel, eventHandler) {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  var previousEventStartTime = currentEventStartTime;
  currentPriorityLevel = priorityLevel;
  currentEventStartTime = getCurrentTime();

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentEventStartTime = previousEventStartTime;

    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;
  return function() {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    var previousEventStartTime = currentEventStartTime;
    currentPriorityLevel = parentPriorityLevel;
    currentEventStartTime = getCurrentTime();

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
      currentEventStartTime = previousEventStartTime;
      flushImmediateWork();
    }
  };
}

function unstable_scheduleCallback(callback, deprecated_options) {
  var startTime =
    currentEventStartTime !== -1 ? currentEventStartTime : getCurrentTime();

  var expirationTime;
  // 如果传入了 timeout，则使用传入的 timeout
  // 否则根据当前的优先级，来计算过期时间
  // 因为过期后，会第一时间得到执行，所以优先级越高，expirationTime 越小
  // 默认的优先级是 Normal
  // var IMMEDIATE_PRIORITY_TIMEOUT = -1; // 立即过期
  // var USER_BLOCKING_PRIORITY = 250;
  // var NORMAL_PRIORITY_TIMEOUT = 5000;
  // var LOW_PRIORITY_TIMEOUT = 10000;
  // var IDLE_PRIORITY = maxSigned31BitInt; // 永不过期
  if (
    typeof deprecated_options === 'object' &&
    deprecated_options !== null &&
    typeof deprecated_options.timeout === 'number'
  ) {
    // FIXME: Remove this branch once we lift expiration times out of React.
    expirationTime = startTime + deprecated_options.timeout;
  } else {
    switch (currentPriorityLevel) {
      case ImmediatePriority:
        expirationTime = startTime + IMMEDIATE_PRIORITY_TIMEOUT;
        break;
      case UserBlockingPriority:
        expirationTime = startTime + USER_BLOCKING_PRIORITY;
        break;
      case IdlePriority:
        expirationTime = startTime + IDLE_PRIORITY;
        break;
      case LowPriority:
        expirationTime = startTime + LOW_PRIORITY_TIMEOUT;
        break;
      case NormalPriority:
      default:
        expirationTime = startTime + NORMAL_PRIORITY_TIMEOUT;
    }
  }
  // 建立一个新的节点，用于存放 callback 和 优先级等信息
  var newNode = {
    callback,
    priorityLevel: currentPriorityLevel,
    expirationTime,
    next: null,
    previous: null,
  };

  // Insert the new callback into the list, ordered first by expiration, then
  // by insertion. So the new callback is inserted any other callback with
  // equal expiration.
  // 如果链表为空的话，则将这个节点设为首节点
  // 双向循环链表，优势：在删除时，可以直接找到前驱节点，而不用遍历两次，或保存前驱节点。时间与空间复杂度更优
  if (firstCallbackNode === null) {
    // This is the first callback in the list.
    firstCallbackNode = newNode.next = newNode.previous = newNode;
    // 确保这个 Callback 进入了调度流程
    ensureHostCallbackIsScheduled();
  } else {
    var next = null;
    var node = firstCallbackNode;
    // 开始遍历
    // 双向循环链表中，只要遍历时，当前元素不为第一个节点，即代表正在遍历中。
    // 否则，则认为遍历结束
    do {
      // 遍历时，遍历的节点过期时间大于当前节点的过期时间
      // 也就是优先级低于当前节点
      // 则当前节点应该插入至遍历的节点之前
      // 同时结束遍历
      if (node.expirationTime > expirationTime) {
        // The new callback expires before this one.
        next = node;
        break;
      }
      node = node.next;
    } while (node !== firstCallbackNode);

    // 如果没有找到优先级比当前节点低的，则代表当前节点的优先级最低，应该插入至队尾
    if (next === null) {
      // No callback with a later expiration was found, which means the new
      // callback has the latest expiration in the list.
      // 将当前节点的 Next 设为链表首节点
      next = firstCallbackNode;
    } else if (next === firstCallbackNode) {
      // 如果找到的节点是链表首节点，则证明当前节点的优先级最高，应该将首节点设置为当前节点
      // 且
      // The new callback has the earliest expiration in the entire list.
      firstCallbackNode = newNode;
      ensureHostCallbackIsScheduled();
    }

    // 这儿则是插入节点的操作
    // 将遍历得到的节点之前的那个节点，遍历得到的节点，当前节点，分别记为：Prev，Next，NewNode
    // 获取到之前的节点，并将之前的节点的 Next 设置为新的节点，则 Prev -> NewNode
    // 将遍历得到的节点的 Previous 设置为新的节点，则 NewNode <- Next
    // 将新节点与Prev，Next 连接起来，则： Prev <--> NewNode <--> Next
    // 1.当遍历得到的节点为首节点时：
    //    首节点 = 当前节点
    //   优先级最低的节点 <--> 当前节点（首节点） <--> 原首节点
    // 2. 当遍历到的节点为空，当前节点为优先级最低的节点时：
    //    遍历得到的节点 = 首节点
    //    优先级倒数第二低的节点 <--> 当前节点（优先级最低） <--> 原首节点
    // 3. 当只有首节点时
    //    首节点 = 当前节点
    //    当前节点（首节点） <--> 原首节点
    var previous = next.previous;
    previous.next = next.previous = newNode;
    newNode.next = next;
    newNode.previous = previous;
  }

  // 该数据结构与插入规则的好处在于，可以保证链表中的元素，在插入时就已经按优先级排序

  return newNode;
}

function unstable_cancelCallback(callbackNode) {
  var next = callbackNode.next;
  if (next === null) {
    // Already cancelled.
    return;
  }

  if (next === callbackNode) {
    // This is the only scheduled callback. Clear the list.
    firstCallbackNode = null;
  } else {
    // Remove the callback from its position in the list.
    if (callbackNode === firstCallbackNode) {
      firstCallbackNode = next;
    }
    var previous = callbackNode.previous;
    previous.next = next;
    next.previous = previous;
  }

  callbackNode.next = callbackNode.previous = null;
}

function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;
}

function unstable_shouldYield() {
  return (
    !currentDidTimeout &&
    ((firstCallbackNode !== null &&
      firstCallbackNode.expirationTime < currentExpirationTime) ||
      shouldYieldToHost())
  );
}

// The remaining code is essentially a polyfill for requestIdleCallback. It
// works by scheduling a requestAnimationFrame, storing the time for the start
// of the frame, then scheduling a postMessage which gets scheduled after paint.
// Within the postMessage handler do as much work as possible until time + frame
// rate. By separating the idle call into a separate event tick we ensure that
// layout, paint and other browser work is counted against the available time.
// The frame rate is dynamically adjusted.

// We capture a local reference to any global, in case it gets polyfilled after
// this module is initially evaluated. We want to be using a
// consistent implementation.
var localDate = Date;

// This initialization code may run even on server environments if a component
// just imports ReactDOM (e.g. for findDOMNode). Some environments might not
// have setTimeout or clearTimeout. However, we always expect them to be defined
// on the client. https://github.com/facebook/react/pull/13088
var localSetTimeout = typeof setTimeout === 'function' ? setTimeout : undefined;
var localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : undefined;

// We don't expect either of these to necessarily be defined, but we will error
// later if they are missing on the client.
var localRequestAnimationFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : undefined;
var localCancelAnimationFrame =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined;

var getCurrentTime;

// requestAnimationFrame does not run when the tab is in the background. If
// we're backgrounded we prefer for that work to happen so that the page
// continues to load in the background. So we also schedule a 'setTimeout' as
// a fallback.
// TODO: Need a better heuristic for backgrounded work.
var ANIMATION_FRAME_TIMEOUT = 100;
var rAFID;
var rAFTimeoutID;
// requestAnimationFrameWithTimeout 是增强版的 raf
// 原有的 raf，在浏览器的 tab 切换至后台时，是不会执行的。 而 setTimeout 则不受该影响。
// 但是 react 做 scheduler 调度时，本身就希望后台完成更多的工作。
// 所以在执行 requestAnimationFrameWithTimeout 函数时，同时会启动两个定时器，一个是 raf，一个是 setTimeout。
// raf 在 100ms 内执行？
//    True：则代表 raf 正常运转。取消设置的 setTimeout 定时器
//    False：setTimeout 定时器执行，并且取消 raf 定时器
// 这样可以保证无论如何，回调都会被顺利执行。
var requestAnimationFrameWithTimeout = function(callback) {
  // schedule rAF and also a setTimeout
  rAFID = localRequestAnimationFrame(function(timestamp) {
    // cancel the setTimeout
    localClearTimeout(rAFTimeoutID);
    callback(timestamp);
  });
  rAFTimeoutID = localSetTimeout(function() {
    // cancel the requestAnimationFrame
    localCancelAnimationFrame(rAFID);
    callback(getCurrentTime());
  }, ANIMATION_FRAME_TIMEOUT);
};

if (hasNativePerformanceNow) {
  var Performance = performance;
  getCurrentTime = function() {
    return Performance.now();
  };
} else {
  getCurrentTime = function() {
    return localDate.now();
  };
}

var requestHostCallback;
var cancelHostCallback;
var shouldYieldToHost;

// 这儿几个核心方法，在不同平台会有不同的实现方式
// 测试环境下，取注入在 window 变量上的几个函数
// 非 DOM 的环境下,如 React Native，则采取 setTimeout 实现
// 浏览器环境下，则采用原生 Api 实现
if (typeof window !== 'undefined' && window._schedMock) {
  // Dynamic injection, only for testing purposes.
  var impl = window._schedMock;
  requestHostCallback = impl[0];
  cancelHostCallback = impl[1];
  shouldYieldToHost = impl[2];
} else if (

  // If Scheduler runs in a non-DOM environment, it falls back to a naive
// implementation using setTimeout.
  typeof window === 'undefined' ||
  // Check if MessageChannel is supported, too.
  typeof MessageChannel !== 'function'
) {
  var _callback = null;
  var _currentTime = -1;
  var _flushCallback = function(didTimeout, ms) {
    if (_callback !== null) {
      var cb = _callback;
      _callback = null;
      try {
        _currentTime = ms;
        cb(didTimeout);
      } finally {
        _currentTime = -1;
      }
    }
  };
  requestHostCallback = function(cb, ms) {
    if (_currentTime !== -1) {
      // Protect against re-entrancy.
      setTimeout(requestHostCallback, 0, cb, ms);
    } else {
      _callback = cb;
      setTimeout(_flushCallback, ms, true, ms);
      setTimeout(_flushCallback, maxSigned31BitInt, false, maxSigned31BitInt);
    }
  };
  cancelHostCallback = function() {
    _callback = null;
  };
  shouldYieldToHost = function() {
    return false;
  };
  getCurrentTime = function() {
    return _currentTime === -1 ? 0 : _currentTime;
  };
} else {

  // 执行过程中，首先会检测 raf 与 cancelRaf 两个函数是否存在，如果不存在则提示用户下载 Polyfill

  if (typeof console !== 'undefined') {
    // TODO: Remove fb.me link

    if (typeof localRequestAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support requestAnimationFrame. " +
        'Make sure that you load a ' +
        'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
    if (typeof localCancelAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support cancelAnimationFrame. " +
        'Make sure that you load a ' +
        'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
  }

  var scheduledHostCallback = null;
  var isMessageEventScheduled = false;
  var timeoutTime = -1;

  var isAnimationFrameScheduled = false;

  var isFlushingHostCallback = false;

  var frameDeadline = 0;
  // We start out assuming that we run at 30fps but then the heuristic tracking
  // will adjust this value to a faster fps if we get more frequent animation
  // frames.
  var previousFrameTime = 33;
  // activeFrameTime 被认为是每一帧的运行时间，1000 / 30fps = 33ms
  var activeFrameTime = 33;

  // Host 这一帧的空余时间到期了，应该暂停了
  shouldYieldToHost = function() {
    // 当前时间 > 这一帧的截至时间
    // 该帧过期
    // return true 则代表应该被暂停
    return getCurrentTime() > frameDeadline;
    // 原来的虽然也能看，但是很不利于自己理解
    // return frameDeadline <= getCurrentTime();
  };

  // 在这儿，Schedule 利用 MessageChannel Api（宏任务），执行时机在浏览器 Repaint 前
  // 确保任务在浏览器 Repaint 得到正确的执行
  // 执行队列：JS Ops -> MessageChannel -> Repaint
  // We use the postMessage trick to defer idle work until after the repaint.
  var channel = new MessageChannel();
  var port = channel.port2;

  channel.port1.onmessage = function(event) {
    // 当接收到消息时，将 isMessageEventScheduled 设置为 false
    isMessageEventScheduled = false;

    // 通过 prevScheduledCallback/prevTimeoutTime 保存回调函数与过期时间，从而将 scheduledHostCallback 置空，确保可以接受回调
    // 同时避免在运行过程中，触发了新的 requestHostCallback 函数，覆盖了原有的值
    var prevScheduledCallback = scheduledHostCallback;
    // timeoutTime = 执行 unscheduled_callback 时 performance.now() + 优先级过期时间
    var prevTimeoutTime = timeoutTime;
    scheduledHostCallback = null;
    timeoutTime = -1;
    // 当前时间为 performance.now() 返回的时间
    var currentTime = getCurrentTime();

    var didTimeout = false;
    // 该帧过期时间 - 当前时间 <= 0 很绕，不如翻译为：当前时间 - 该帧过期时间 >= 0。
    // 也就是当前时间超过了过期时间，该任务过期
    if (frameDeadline - currentTime <= 0) {
      // There's no time left in this idle period. Check if the callback has
      // a timeout and whether it's been exceeded.
      // 当之前的优先级不等于 IMMEDIATE_PRIORITY_TIMEOUT（人为设置过期）且过期时间 <= 当前时间时（已经过期），我们认定任务执行超时
      // 在该帧超时且任务超时的情况下，我们强制执行该任务
      if (prevTimeoutTime !== -1 && prevTimeoutTime <= currentTime) {
        // Exceeded the timeout. Invoke the callback even though there's no
        // time left.
        didTimeout = true;
      } else {
        // 如果该帧超时，但是任务没有超时
        // 我们会把这个任务通过 raf ，放到下一帧执行。
        // 并继续把 scheduledHostCallback 和 timeoutTime 设置为现有的任务。
        // 把主线程占有权从 JS 归还至 React
        // No timeout.
        if (!isAnimationFrameScheduled) {
          // Schedule another animation callback so we retry later.
          isAnimationFrameScheduled = true;
          requestAnimationFrameWithTimeout(animationTick);
        }
        // Exit without invoking the callback.
        scheduledHostCallback = prevScheduledCallback;
        timeoutTime = prevTimeoutTime;
        return;
      }
    }
    // 如果当前帧没有超时，则开始进入回调的执行流程。
    // 如果之前有回调，下面则代表要执行回调，会将 isFlushingHostCallback 设置为 True
    // 本处使用了 try/finally 的技术，没有 catch，确保最后 isFlushingHostCallback 最后都会被设置为 false。
    // 而错误则会被抛出。
    // 在调用回调时，会传入 didTimeout 参数，来告知回调函数，当前的执行是否时超时情况下执行。
    if (prevScheduledCallback !== null) {
      isFlushingHostCallback = true;
      try {
        prevScheduledCallback(didTimeout);
      } finally {
        isFlushingHostCallback = false;
      }
    }
  };

  // animationTick 是传入 raf 的函数
  // 其中参数 rafTime 是 raf 在调用回调时传入的参数，是 performance.now() 返回的时间，代表进入该页面后的时间，精度高且不像 Date 一样受地区影响
  var animationTick = function(rafTime) {
    // 当设置了回调需要执行时，这儿会提前安排好下一次 raf。
    // 不过此处存在疑惑，因为他这儿给的原因时：如果在一帧开始时安排回调，那么我们可以得到尽快的执行，但如果是在快结束时安排，则会有浏览器丢帧，不执行回调的风险
    // 如果没有回调，则函数结束
    if (scheduledHostCallback !== null) {
      // Eagerly schedule the next animation callback at the beginning of the
      // frame. If the scheduler queue is not empty at the end of the frame, it
      // will continue flushing inside that callback. If the queue *is* empty,
      // then it will exit immediately. Posting the callback at the start of the
      // frame ensures it's fired within the earliest possible frame. If we
      // waited until the end of the frame to post the callback, we risk the
      // browser skipping a frame and not firing the callback until the frame
      // after that.
      requestAnimationFrameWithTimeout(animationTick);
    } else {
      // No pending work. Exit.
      isAnimationFrameScheduled = false;
      return;
    }
    // nextFrameTime 可以用于计算 raf 的具体时差，而 raf 的具体时差是可以推算出 FPS 的。也就可以设置正确的过期时间
    // 计算 raf 的过期时间，需要上一次 raf 的执行时间，而 frameDeadline 恰巧是 上一次 raf 的执行时间 + 33ms。
    // 所以计算时：本次 raf 执行时间 - (上一次 raf 的执行时间 + 33ms) = currentRaf - lastRaf - 33ms
    // 也就是 frameDeadline 让计算时多减去了 33ms。因此在计算时，需要加回去。则最后为：
    // currentRaf - lastRaf - 33ms + 33ms = currentRaf - lastRaf = raf 的时差

    // 例子：当 60 fps 的情况下，假设执行的时间是：100，则设定这一帧的过期时间是 133
    // 但由于帧率高，下一帧执行时，是 116，则 nextFrameTime 为 116 - 133 + 33 = 16
    // nextFrameTime 就是raf的时差，也就是一帧的时间

    // 每帧的时间 < 33ms 时，则有可能浏览器帧率高于 30 FPS， 将 previousFrameTime 设置为一帧执行时间，而后需要进行再次判断。
    // 在此，因为浏览器有以下特征：当 1 帧的执行时间过长时，下一帧的时间可能会比较短。
    // 因此只有连续两帧的时间都低于 33ms 时，才可以判定，屏幕刷新率确实高于 30 FPS。
    // 而两次都都低于，也可以判定这是目前情况下，最高的刷新率。因为 raf 不可能超过屏幕的刷新率，所以会越来越逼近 60 fps bi'jin
    // 因此此处有 previousFrameTime 用于存储上一帧的实际时间，nextFrameTime 来存储当前帧的时间。
    // 两者均低于 33ms 时，则更新屏幕刷新率。
    var nextFrameTime = rafTime - frameDeadline + activeFrameTime;
    if (
      nextFrameTime < activeFrameTime &&
      previousFrameTime < activeFrameTime
    ) {
      // 当每帧时间 < 8ms 时，代表屏幕刷新率高于 120hz，再此 React 做了防御，将高于 120hz 的屏幕通通认定为 120hz
      if (nextFrameTime < 8) {
        // Defensive coding. We don't support higher frame rates than 120hz.
        // If the calculated frame time gets lower than 8, it is probably a bug.
        nextFrameTime = 8;
      }
      // If one frame goes long, then the next one can be short to catch up.
      // If two frames are short in a row, then that's an indication that we
      // actually have a higher frame rate than what we're currently optimizing.
      // We adjust our heuristic dynamically accordingly. For example, if we're
      // running on 120hz display or 90hz VR display.
      // Take the max of the two in case one of them was an anomaly due to
      // missed frame deadlines.
      // 在更新每一帧的时间时，会从 previousFrameTime 与 nextFrameTime 之间取较大值。
      // activeFrameTime 值越大，则代表帧数越低。较大的那个，我认为是更为安全的帧率值与到期时间。
      activeFrameTime =
        nextFrameTime < previousFrameTime ? previousFrameTime : nextFrameTime;
    } else {
      previousFrameTime = nextFrameTime;
    }
    // 设置该帧的到期时间为 当前时间 + 浏览器中每一帧的执行时间
    frameDeadline = rafTime + activeFrameTime;
    // 调度时，将 isMessageEventScheduled 设置为 True，并且将任务通过 MessageChanel 进行调度
    if (!isMessageEventScheduled) {
      isMessageEventScheduled = true;
      port.postMessage(undefined);
    }
  };

  // requestHostCallback，会将 scheduledHostCallback设置为传入的回调，并且将 timeoutTime 设置为传入的超时时间
  requestHostCallback = function(callback, absoluteTimeout) {
    scheduledHostCallback = callback;
    timeoutTime = absoluteTimeout;

    // 在执行回调时，会将 isFlushingHostCallback 设为 True。函数执行完毕时设置为 False
    // 所以当 isFlushingHostCallback 为 True 时，可以判定为是之前安排的回调函数正在执行。

    // 当满足以下条件之一时，该回调会被尽快的执行（ASAP）
    //    1. 超时时间 < 0，也就是该任务的优先级为：IMMEDIATE_PRIORITY_TIMEOUT，要求即刻执行
    //    2. 当前的 requestHostCallback 调用，是在上一个安排的回调中执行的。也就是本身处于 MessageChannel 处理阶段。
    //       此时如果通过 port.postMessage 安排回调，则该回调将在本帧执行。也就是优先级最高的执行方式
    //       流程图：
    //       JS Ops -> MessageChannel -> 处理 Message1 -> Message1 调用回调时插入了新消息 Message2 -> 处理 Message2 -> Repaint
    if (isFlushingHostCallback || absoluteTimeout < 0) {
      // Don't wait for the next frame. Continue working ASAP, in a new event.
      port.postMessage(undefined);
    } else if (!isAnimationFrameScheduled) {
      // 或者上一次的 raf 结束后，并没有安排新的 raf。
      // 所以我们需要手动安排 raf，确保在下一帧任务会得到执行。
      // If rAF didn't already schedule one, we need to schedule a frame.
      // TODO: If this rAF doesn't materialize because the browser throttles, we
      // might want to still have setTimeout trigger rIC as a backup to ensure
      // that we keep performing work.
      isAnimationFrameScheduled = true;
      requestAnimationFrameWithTimeout(animationTick);
    }
  };

  cancelHostCallback = function() {
    scheduledHostCallback = null;
    isMessageEventScheduled = false;
    timeoutTime = -1;
  };
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  unstable_shouldYield,
  getCurrentTime as unstable_now,
};

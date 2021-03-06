const hash = require('object-hash')
const { decycle } = require('cycle')
import isEqual from 'lodash.isequal'
import React from 'react'
import {
  Platform,
  StyleSheet,
  SectionListProps,
  findNodeHandle,
  ViewStyle,
  NativeScrollEvent,
  SectionListData,
} from 'react-native'
import {
  PanGestureHandler,
  State as GestureState,
  GestureHandlerGestureEventNativeEvent,
  PanGestureHandlerEventExtra,
  PanGestureHandlerGestureEvent,
} from 'react-native-gesture-handler'
import Animated from 'react-native-reanimated'
import { springFill, setupCell } from './procs'

const createNativeWrapper = require('react-native-gesture-handler/createNativeWrapper')

import { SectionList } from './SectionList'

const AnimatedSectionList = Animated.createAnimatedComponent(SectionList())

const {
  Value,
  abs,
  set,
  cond,
  add,
  sub,
  event,
  block,
  eq,
  neq,
  and,
  or,
  call,
  onChange,
  divide,
  greaterThan,
  greaterOrEq,
  lessOrEq,
  not,
  Clock,
  clockRunning,
  startClock,
  stopClock,
  spring,
  defined,
  min,
  max,
  debug,
} = Animated

// Fire onScrollComplete when within this many
// px of target offset
const scrollPositionTolerance = 2
const defaultAnimationConfig = {
  damping: 20,
  mass: 0.2,
  stiffness: 100,
  overshootClamping: false,
  restSpeedThreshold: 0.2,
  restDisplacementThreshold: 0.2,
}

const defaultProps = {
  autoscrollThreshold: 30,
  autoscrollSpeed: 100,
  animationConfig: defaultAnimationConfig as Animated.SpringConfig,
  scrollEnabled: true,
  dragHitSlop: 0,
  activationDistance: 0,
  dragItemOverflow: false,
}

type DefaultProps = Readonly<typeof defaultProps>

type AnimatedSectionListType<T> = { getNode: () => typeof AnimatedSectionList }

export type DragEndParams<T> = {
  beforeChangesArr: T[]
  dataArr: T[]
  from: number
  to: number
  promise: (value: void | PromiseLike<void>) => void
}

interface RenderItemParams<T> {
  item: T
  index?: number // This is technically a "last known index" since cells don't necessarily rerender when their index changes
  drag: () => void
  isActive: boolean
}
interface sectionValue<T> {
  data: T[]
  section: string
}

type Modify<T, R> = Omit<T, keyof R> & R
type Props<T, K> = Omit<
  Modify<
    SectionListProps<T>,
    {
      autoscrollSpeed?: number
      autoscrollThreshold?: number
      data: sectionValue<T>[]
      onRef?: (ref: any) => void
      onDragBegin?: (index: number) => void
      onRelease?: (index: number) => void
      onDragEnd?: (params: DragEndParams<T>) => void
      renderItem: (params: RenderItemParams<T>) => React.ReactNode
      renderSectionHeader: (params: RenderItemParams<K>) => React.ReactNode
      renderPlaceholder?: (params: {
        item: any
        index: number
      }) => React.ReactNode
      onMove?: (gestureEvent: PanGestureHandlerGestureEvent) => void
      isSectionHeader?: (itemToCheck: any) => boolean
      animationConfig: Partial<Animated.SpringConfig>
      activationDistance?: number
      debug?: boolean
      layoutInvalidationKey?: string
      onScrollOffsetChange?: (scrollOffset: number) => void
      onPlaceholderIndexChange?: (placeholderIndex: number) => void
      dragItemOverflow?: boolean
    } & Partial<DefaultProps>
  >,
  'sections'
>

type State = {
  activeKey: string | null
  hoverComponent: React.ReactNode | null
  hoverComponentHeight: number
}

type CellData = {
  size: Animated.Value<number>
  offset: Animated.Value<number>
  measurements: {
    size: number
    offset: number
  }
  style: Animated.AnimateProps<ViewStyle, {}>
  currentIndex: Animated.Value<number>
  onLayout: () => void
  onUnmount: () => void
}

// Run callback on next paint:
// https://stackoverflow.com/questions/26556436/react-after-render-code
function onNextFrame(callback: () => void) {
  setTimeout(function() {
    requestAnimationFrame(callback)
  })
}

class DraggableSectionList<T, K> extends React.Component<Props<T, K>, State> {
  headersAndData: any[] = []

  state: State = {
    activeKey: null,
    hoverComponent: null,
    hoverComponentHeight: 0,
  }

  containerRef = React.createRef<Animated.View>()
  SectionListRef = React.createRef<AnimatedSectionListType<T>>()
  panGestureHandlerRef = React.createRef<PanGestureHandler>()

  containerSize = new Value<number>(0)

  activationDistance = new Value<number>(0)
  touchAbsolute = new Value<number>(0)
  touchCellOffset = new Value<number>(0)
  panGestureState = new Value(GestureState.UNDETERMINED)

  isPressedIn = {
    native: new Value<number>(0),
    js: false,
  }

  hasMoved = new Value(0)
  disabled = new Value(0)

  activeIndex = new Value<number>(-1)
  isHovering = greaterThan(this.activeIndex, -1)

  spacerIndex = new Value<number>(-1)
  activeCellSize = new Value<number>(0)

  scrollOffset = new Value<number>(0)
  scrollViewSize = new Value<number>(0)
  isScrolledUp = lessOrEq(sub(this.scrollOffset, scrollPositionTolerance), 0)
  isScrolledDown = greaterOrEq(
    add(this.scrollOffset, this.containerSize, scrollPositionTolerance),
    this.scrollViewSize
  )

  hoverAnimUnconstrained = sub(this.touchAbsolute, this.touchCellOffset)
  hoverAnimConstrained = min(
    sub(this.containerSize, this.activeCellSize),
    max(0, this.hoverAnimUnconstrained)
  )

  hoverAnim = this.props.dragItemOverflow
    ? this.hoverAnimUnconstrained
    : this.hoverAnimConstrained
  hoverMid = add(this.hoverAnim, divide(this.activeCellSize, 2))
  hoverOffset = add(this.hoverAnim, this.scrollOffset)

  placeholderOffset = new Value(0)
  placeholderPos = sub(this.placeholderOffset, this.scrollOffset)

  hoverTo = new Value(0)
  hoverClock = new Clock()
  hoverAnimState = {
    finished: new Value(0),
    velocity: new Value(0),
    position: new Value(0),
    time: new Value(0),
  }

  hoverAnimConfig = {
    ...defaultAnimationConfig,
    ...this.props.animationConfig,
    toValue: this.hoverTo,
  }

  distToTopEdge = max(0, this.hoverAnim)
  distToBottomEdge = max(
    0,
    sub(this.containerSize, add(this.hoverAnim, this.activeCellSize))
  )

  cellAnim = new Map<
    string,
    {
      config: Animated.SpringConfig
      state: Animated.SpringState
      clock: Animated.Clock
    }
  >()
  cellData = new Map<string, CellData>()
  cellRefs = new Map<string, React.RefObject<Animated.View>>()

  moveEndParams = [this.activeIndex, this.spacerIndex]

  resetHoverSpring = [
    set(this.hoverAnimState.time, 0),
    set(this.hoverAnimState.position, this.hoverAnimConfig.toValue),
    set(this.touchAbsolute, this.hoverAnimConfig.toValue),
    set(this.touchCellOffset, 0),
    set(this.hoverAnimState.finished, 0),
    set(this.hoverAnimState.velocity, 0),
    set(this.hasMoved, 0),
  ]

  keyToIndex = new Map<string, number>()

  /** Whether we've sent an incomplete call to the SectionList to do a scroll */
  isAutoscrolling = {
    native: new Value<number>(0),
    js: false,
  }

  queue: (() => void | Promise<void>)[] = []

  static getDerivedStateFromProps(props: Props<any, any>) {
    return {
      extraData: props.extraData,
    }
  }

  static defaultProps = defaultProps

  constructor(props: Props<T, K>) {
    super(props)
    const { data, onRef } = props
    data.forEach((item) => {
      this.headersAndData.push(item.section)
      item.data.forEach((dataItem) => {
        this.headersAndData.push(dataItem)
      })
    })
    this.headersAndData.forEach((dataOrHeader, index) => {
      const key = this.keyExtractor(dataOrHeader, index)
      this.keyToIndex.set(key, index)
    })
    onRef && onRef(this.SectionListRef)
  }

  dataKeysHaveChanged = (a: sectionValue<T>[], b: sectionValue<T>[]) => {
    const lengthOfSectionsChanged =
      Object.keys(a).length !== Object.keys(b).length
    if (lengthOfSectionsChanged) return true
    let AheadersAndData: any[] = []
    let BheadersAndData: any[] = []

    a.forEach((item) => {
      AheadersAndData = [...AheadersAndData, item.section]
      item.data.forEach((dataItem) => {
        AheadersAndData = [...AheadersAndData, dataItem]
      })
    })
    const aKeys = AheadersAndData.map((dataOrHeader, index) =>
      this.keyExtractor(dataOrHeader, index)
    )

    b.forEach((item) => {
      BheadersAndData = [...BheadersAndData, item.section]
      item.data.forEach((dataItem) => {
        BheadersAndData = [...BheadersAndData, dataItem]
      })
    })
    const bKeys = BheadersAndData.map((dataOrHeader, index) =>
      this.keyExtractor(dataOrHeader, index)
    )

    const sameKeys = aKeys.every((k) => bKeys.includes(k))
    console.log(`same
    key? ${sameKeys}`)
    return sameKeys
  }

  lastKey = ''

  componentDidUpdate = (prevProps: Props<T, K>, prevState: State) => {
    const layoutInvalidationKeyHasChanged =
      prevProps.layoutInvalidationKey !== this.props.layoutInvalidationKey ||
      this.lastKey !== this.props.layoutInvalidationKey

    let dataHasChanged = false

    if (layoutInvalidationKeyHasChanged || dataHasChanged) {
      if (this.props.layoutInvalidationKey) {
        this.lastKey = this.props.layoutInvalidationKey
      }

      this.headersAndData = []
      this.props.data.forEach((item) => {
        this.headersAndData.push(item.section)
        item.data.forEach((dataItem) => {
          this.headersAndData.push(dataItem)
        })
      })

      this.keyToIndex.clear()
      this.headersAndData.forEach((dataOrHeader, index) => {
        const key = this.keyExtractor(dataOrHeader, index)
        this.keyToIndex.set(key, index)
      })

      // Remeasure on next paint
      this.updateCellData()
      onNextFrame(this.flushQueue)

      if (
        layoutInvalidationKeyHasChanged ||
        this.dataKeysHaveChanged(prevProps.data, this.props.data)
      ) {
        this.queue.push(() => this.measureAll())
      }
    }
    if (!prevState.activeKey && this.state.activeKey) {
      const index = this.keyToIndex.get(this.state.activeKey)
      if (index !== undefined) {
        this.spacerIndex.setValue(index)
        this.activeIndex.setValue(index)
        this.touchCellOffset.setValue(0)
        this.isPressedIn.native.setValue(1)
      }
      const cellData = this.cellData.get(this.state.activeKey)
      if (cellData) {
        this.touchAbsolute.setValue(sub(cellData.offset, this.scrollOffset))
        this.activeCellSize.setValue(cellData.measurements.size)
      }
    }
  }

  flushQueue = async () => {
    this.queue.forEach((fn) => fn())
    this.queue = []
  }

  resetHoverState = () => {
    this.activeIndex.setValue(-1)
    this.spacerIndex.setValue(-1)
    this.disabled.setValue(0)
    if (this.state.hoverComponent !== null || this.state.activeKey !== null) {
      this.setState({
        hoverComponent: null,
        activeKey: null,
      })
    }
  }

  drag = (hoverComponent: React.ReactNode, activeKey: string) => {
    if (this.state.hoverComponent) {
      // We can't drag more than one row at a time
      // TODO: Put action on queue?
      if (this.props.debug) console.log("## Can't set multiple active items")
    } else {
      this.isPressedIn.js = true

      this.setState(
        {
          activeKey,
          hoverComponent,
        },
        () => {
          const index = this.keyToIndex.get(activeKey)
          const { onDragBegin } = this.props
          if (index !== undefined && onDragBegin) {
            onDragBegin(index)
          }
        }
      )
    }
  }

  onRelease = ([index]: readonly number[]) => {
    const { onRelease } = this.props
    this.isPressedIn.js = false
    onRelease && onRelease(index)
  }

  onDragEnd = async ([from, to]: readonly number[]) => {
    const promise = new Promise<void>((resolve, reject) => {
      const { onDragEnd, isSectionHeader } = this.props

      let newData = [...this.headersAndData]
      if (from !== to) {
        this.headersAndData.splice(from, 1)
        this.headersAndData.splice(to, 0, newData[from])
      }
      if (isSectionHeader && onDragEnd) {
        onDragEnd({
          from,
          to,
          beforeChangesArr: newData,
          dataArr: this.headersAndData,
          promise: resolve,
        })
      }
      const lo = Math.min(from, to) - 1
      const hi = Math.max(from, to) + 1
      for (let i = lo; i < hi; i++) {
        this.queue.push(() => {
          //         const item = this.headersAndData[i]
          const item = this.headersAndData[i]
          if (!item) return
          const key = this.keyExtractor(item, i)
          return this.measureCell(key)
        })
      }
    })
    await promise
    this.resetHoverState()
  }

  updateCellData = () => {
    return this.headersAndData.forEach((dataOrHeader, index) => {
      const key = this.keyExtractor(dataOrHeader, index)
      const cell = this.cellData.get(key)
      if (cell) cell.currentIndex.setValue(index)
    })
  }

  setCellData = (key: string, index: number) => {
    const clock = new Clock()
    const currentIndex = new Value(index)

    const config = {
      ...this.hoverAnimConfig,
      toValue: new Value(0),
    }

    const state = {
      position: new Value(0),
      velocity: new Value(0),
      time: new Value(0),
      finished: new Value(0),
    }

    this.cellAnim.set(key, { clock, state, config })

    const initialized = new Value(0)
    const size = new Value<number>(0)
    const offset = new Value<number>(0)
    const isAfterActive = new Value(0)
    const translate = new Value(0)

    const runSrping = cond(
      clockRunning(clock),
      springFill(clock, state, config)
    )
    const onHasMoved = startClock(clock)
    const onChangeSpacerIndex = cond(clockRunning(clock), stopClock(clock))
    const onFinished = stopClock(clock)

    const prevTrans = new Value(0)
    const prevSpacerIndex = new Value(-1)

    const anim = setupCell(
      currentIndex,
      initialized,
      size,
      offset,
      isAfterActive,
      translate,
      prevTrans,
      prevSpacerIndex,
      this.activeIndex,
      this.activeCellSize,
      this.hoverOffset,
      this.scrollOffset,
      this.isHovering,
      this.hoverTo,
      this.hasMoved,
      this.spacerIndex,
      config.toValue,
      state.position,
      state.time,
      state.finished,
      runSrping,
      onHasMoved,
      onChangeSpacerIndex,
      onFinished,
      this.isPressedIn.native,
      this.placeholderOffset
    )

    const transform = this.props.horizontal
      ? [{ translateX: anim }]
      : [{ translateY: anim }]

    const style = {
      transform,
    }

    const cellData = {
      initialized,
      currentIndex,
      size,
      offset,
      style,
      onLayout: () => {
        if (this.state.activeKey !== key) this.measureCell(key)
      },
      onUnmount: () => initialized.setValue(0),
      measurements: {
        size: 0,
        offset: 0,
      },
    }
    this.cellData.set(key, cellData)
  }

  measureAll = () => {
    this.headersAndData.forEach((dataOrHeader: any, index: number) => {
      const key = this.keyExtractor(dataOrHeader, index)
      this.measureCell(key)
    })
  }

  measureCell = (key: string): Promise<void> => {
    return new Promise((resolve, reject) => {
      const { horizontal } = this.props

      const onSuccess = (x: number, y: number, w: number, h: number) => {
        const { activeKey } = this.state
        const isHovering = activeKey !== null
        const cellData = this.cellData.get(key)
        const thisKeyIndex = this.keyToIndex.get(key)
        const activeKeyIndex = activeKey
          ? this.keyToIndex.get(activeKey)
          : undefined
        const baseOffset = horizontal ? x : y
        let extraOffset = 0
        if (
          thisKeyIndex !== undefined &&
          activeKeyIndex !== undefined &&
          activeKey
        ) {
          const isAfterActive = thisKeyIndex > activeKeyIndex
          const activeCellData = this.cellData.get(activeKey)
          if (isHovering && isAfterActive && activeCellData) {
            extraOffset = activeCellData.measurements.size
          }
        }

        const size = horizontal ? w : h
        const offset = baseOffset + extraOffset

        if (this.props.debug)
          console.log(
            `measure key ${key}: wdith ${w} height ${h} x ${x} y ${y} size ${size} offset ${offset}`
          )

        if (cellData) {
          cellData.size.setValue(size)
          cellData.offset.setValue(offset)
          cellData.measurements.size = size
          cellData.measurements.offset = offset
        }

        // remeasure on next layout if hovering
        if (isHovering) this.queue.push(() => this.measureCell(key))
        resolve()
      }

      const onFail = () => {
        if (this.props.debug) console.log('## measureLayout fail!', key)
      }

      const ref = this.cellRefs.get(key)
      const viewNode = ref && ref.current && ref.current.getNode()
      const SectionListNode =
        this.SectionListRef.current && this.SectionListRef.current.getNode()

      if (viewNode && SectionListNode) {
        const nodeHandle = findNodeHandle(SectionListNode)
        if (nodeHandle) viewNode.measureLayout(nodeHandle, onSuccess, onFail)
      } else {
        let reason = !ref
          ? 'no ref'
          : !SectionListNode
          ? 'no SectionList node'
          : 'invalid ref'
        if (this.props.debug)
          console.log(`## can't measure ${key} reason: ${reason}`)
        this.queue.push(() => this.measureCell(key))
        return resolve()
      }
    })
  }

  keyExtractor = (item: T, index: number) => {
    if (this.props.keyExtractor) return this.props.keyExtractor(item, index)
    else
      throw new Error('You must provide a keyExtractor to DraggableSectionList')
  }

  onContainerLayout = () => {
    const { horizontal } = this.props
    const containerRef = this.containerRef.current
    if (containerRef) {
      containerRef.getNode().measure((x, y, w, h) => {
        this.containerSize.setValue(horizontal ? w : h)
      })
    }
  }

  onListContentSizeChange = (w: number, h: number) => {
    this.scrollViewSize.setValue(this.props.horizontal ? w : h)
    if (this.props.onContentSizeChange) this.props.onContentSizeChange(w, h)
  }

  targetScrollOffset = new Value<number>(0)
  resolveAutoscroll?: (scrollParams: readonly number[]) => void

  onAutoscrollComplete = (params: readonly number[]) => {
    this.isAutoscrolling.js = false
    if (this.resolveAutoscroll) this.resolveAutoscroll(params)
  }

  scrollToAsync = (offset: number): Promise<readonly number[]> =>
    new Promise((resolve, reject) => {
      this.resolveAutoscroll = resolve
      this.targetScrollOffset.setValue(offset)
      this.isAutoscrolling.native.setValue(1)
      this.isAutoscrolling.js = true
      const SectionListRef = this.SectionListRef.current
      SectionListRef?.getNode()._wrapperListRef._listRef.scrollToOffset({
        offset: offset,
      })
    })

  getScrollTargetOffset = (
    distFromTop: number,
    distFromBottom: number,
    scrollOffset: number,
    isScrolledUp: boolean,
    isScrolledDown: boolean
  ) => {
    if (this.isAutoscrolling.js) return -1
    const { autoscrollThreshold, autoscrollSpeed } = this.props
    const scrollUp = distFromTop < autoscrollThreshold!
    const scrollDown = distFromBottom < autoscrollThreshold!
    if (
      !(scrollUp || scrollDown) ||
      (scrollUp && isScrolledUp) ||
      (scrollDown && isScrolledDown)
    )
      return -1
    const distFromEdge = scrollUp ? distFromTop : distFromBottom
    const speedPct = 1 - distFromEdge / autoscrollThreshold!
    // Android scroll speed seems much faster than ios
    const speed =
      Platform.OS === 'ios' ? autoscrollSpeed! : autoscrollSpeed! / 10
    const offset = speedPct * speed
    const targetOffset = scrollUp
      ? Math.max(0, scrollOffset - offset)
      : scrollOffset + offset
    return targetOffset
  }

  /** Ensure that only 1 call to autoscroll is active at a time */
  autoscrollLooping = false
  autoscroll = async (params: readonly number[]) => {
    if (this.autoscrollLooping) {
      return
    }
    this.autoscrollLooping = true
    try {
      let shouldScroll = true
      let curParams = params
      while (shouldScroll) {
        const [
          distFromTop,
          distFromBottom,
          scrollOffset,
          isScrolledUp,
          isScrolledDown,
        ] = curParams
        const targetOffset = this.getScrollTargetOffset(
          distFromTop,
          distFromBottom,
          scrollOffset,
          !!isScrolledUp,
          !!isScrolledDown
        )
        const scrollingUpAtTop = !!(
          isScrolledUp && targetOffset <= scrollOffset
        )
        const scrollingDownAtBottom = !!(
          isScrolledDown && targetOffset >= scrollOffset
        )
        shouldScroll =
          targetOffset >= 0 &&
          this.isPressedIn.js &&
          !scrollingUpAtTop &&
          !scrollingDownAtBottom

        if (shouldScroll) {
          curParams = await this.scrollToAsync(targetOffset)
        }
      }
    } finally {
      this.autoscrollLooping = false
    }
  }

  isAtTopEdge = lessOrEq(this.distToTopEdge, this.props.autoscrollThreshold!)
  isAtBottomEdge = lessOrEq(
    this.distToBottomEdge,
    this.props.autoscrollThreshold!
  )
  isAtEdge = or(this.isAtBottomEdge, this.isAtTopEdge)

  autoscrollParams = [
    this.distToTopEdge,
    this.distToBottomEdge,
    this.scrollOffset,
    this.isScrolledUp,
    this.isScrolledDown,
  ]

  checkAutoscroll = cond(
    and(
      this.isAtEdge,
      not(and(this.isAtTopEdge, this.isScrolledUp)),
      not(and(this.isAtBottomEdge, this.isScrolledDown)),
      eq(this.panGestureState, GestureState.ACTIVE),
      not(this.isAutoscrolling.native)
    ),
    call(this.autoscrollParams, this.autoscroll)
  )

  onScroll = event([
    {
      nativeEvent: ({ contentOffset }: NativeScrollEvent) =>
        block([
          set(
            this.scrollOffset,
            this.props.horizontal ? contentOffset.x : contentOffset.y
          ),
          cond(
            and(
              this.isAutoscrolling.native,
              or(
                // We've scrolled to where we want to be
                lessOrEq(
                  abs(sub(this.targetScrollOffset, this.scrollOffset)),
                  scrollPositionTolerance
                ),
                // We're at the start, but still want to scroll farther up
                and(
                  this.isScrolledUp,
                  lessOrEq(this.targetScrollOffset, this.scrollOffset)
                ),
                // We're at the end, but still want to scroll further down
                and(
                  this.isScrolledDown,
                  greaterOrEq(this.targetScrollOffset, this.scrollOffset)
                )
              )
            ),
            [
              // Finish scrolling
              set(this.isAutoscrolling.native, 0),
              call(this.autoscrollParams, this.onAutoscrollComplete),
            ]
          ),
        ]),
    },
  ])

  onGestureRelease = [
    cond(
      this.isHovering,
      [
        set(this.disabled, 1),
        cond(defined(this.hoverClock), [
          cond(clockRunning(this.hoverClock), [stopClock(this.hoverClock)]),
          set(this.hoverAnimState.position, this.hoverAnim),
          startClock(this.hoverClock),
        ]),
        [
          call([this.activeIndex], this.onRelease),
          cond(
            not(this.hasMoved),
            call([this.activeIndex], this.resetHoverState)
          ),
        ],
      ],
      call([this.activeIndex], this.resetHoverState)
    ),
  ]

  onPanStateChange = event([
    {
      nativeEvent: ({
        state,
        x,
        y,
      }: GestureHandlerGestureEventNativeEvent & PanGestureHandlerEventExtra) =>
        cond(and(neq(state, this.panGestureState), not(this.disabled)), [
          set(this.panGestureState, state),
          cond(
            eq(this.panGestureState, GestureState.ACTIVE),
            set(
              this.activationDistance,
              sub(this.touchAbsolute, this.props.horizontal ? x : y)
            )
          ),
          cond(
            or(
              eq(state, GestureState.END),
              eq(state, GestureState.CANCELLED),
              eq(state, GestureState.FAILED)
            ),
            this.onGestureRelease
          ),
        ]),
    },
  ])

  onPanGestureEvent = (notFuncEvent: PanGestureHandlerGestureEvent) => {
    const nativeEvent = notFuncEvent.nativeEvent

    if (this.props.onMove) {
      this.props.onMove(notFuncEvent)
    }

    const setValue = () => {
      this.touchAbsolute.setValue(
        add(
          this.props.horizontal
            ? nativeEvent.x
            : nativeEvent.y - this.state.hoverComponentHeight / 2,
          this.activationDistance
        )
      )
      return this.touchAbsolute
    }

    const setMoved = () => {
      this.hasMoved.setValue(1 as any)
      return this.hasMoved
    }

    cond(
      and(
        this.isHovering,
        eq(this.panGestureState, GestureState.ACTIVE),
        not(this.disabled)
      ),
      [cond(not(this.hasMoved), setMoved()), setValue()]
    )
  }

  hoverComponentTranslate = cond(
    clockRunning(this.hoverClock),
    this.hoverAnimState.position,
    this.hoverAnim
  )

  hoverComponentOpacity = and(
    this.isHovering,
    neq(this.panGestureState, GestureState.CANCELLED)
  )

  renderHoverComponent = () => {
    const { hoverComponent } = this.state
    const { horizontal } = this.props

    return (
      <Animated.View
        onLayout={(e) => {
          this.setState({ hoverComponentHeight: e.nativeEvent.layout.height })
        }}
        style={[
          horizontal
            ? styles.hoverComponentHorizontal
            : styles.hoverComponentVertical,
          {
            opacity: this.hoverComponentOpacity,
            transform: [
              {
                [`translate${horizontal ? 'X' : 'Y'}`]: this
                  .hoverComponentTranslate,
              },
              // We need the cast because the transform array usually accepts
              // only specific keys, and we dynamically generate the key
              // above
            ] as Animated.AnimatedTransform,
          },
        ]}
      >
        {hoverComponent}
      </Animated.View>
    )
  }

  renderSectionHeader = (info: SectionListData<T>) => {
    const index = this.headersAndData.indexOf(info.section.section)
    const { activeKey } = this.state
    const key = this.keyExtractor(info.section.section, index)
    if (index !== this.keyToIndex.get(key)) this.keyToIndex.set(key, index)
    if (!this.cellData.get(key)) this.setCellData(key, index)
    let ref = this.cellRefs.get(key)
    if (!ref) {
      ref = React.createRef()
      this.cellRefs.set(key, ref)
    }
    const { onUnmount } = this.cellData.get(key) || {
      onUnmount: () => {
        if (this.props.debug) console.log('## error, no cellData')
      },
    }
    const cellData = this.cellData.get(key)
    if (!cellData) return null
    const { horizontal } = this.props
    const isActiveCell = activeKey === key
    const { style, onLayout: onCellLayout } = cellData
    return (
      <Animated.View style={style}>
        <Animated.View
          pointerEvents={activeKey ? 'none' : 'auto'}
          style={{
            flexDirection: horizontal ? 'row' : 'column',
          }}
        >
          <Animated.View
            ref={ref}
            onLayout={onCellLayout}
            style={isActiveCell ? { opacity: 0 } : undefined}
          >
            <RowSection
              extraData={this.props.extraData}
              itemKey={key}
              keyToIndex={this.keyToIndex}
              renderSectionHeader={this.props.renderSectionHeader}
              item={info.section}
              drag={this.drag}
              onUnmount={onUnmount}
            />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    )
  }

  renderItem = (item: RenderItemParams<T>) => {
    const index = this.headersAndData.indexOf(item.item)
    const key = this.keyExtractor(item.item, index)
    const { activeKey } = this.state
    const { horizontal } = this.props
    if (index !== this.keyToIndex.get(key)) this.keyToIndex.set(key, index)
    if (!this.cellData.get(key)) this.setCellData(key, index)
    let ref = this.cellRefs.get(key)
    if (!ref) {
      ref = React.createRef()
      this.cellRefs.set(key, ref)
    }
    const { onUnmount } = this.cellData.get(key) || {
      onUnmount: () => {
        if (this.props.debug) console.log('## error, no cellData')
      },
    }
    const cellData = this.cellData.get(key)
    if (!cellData) return null
    const { style, onLayout: onCellLayout } = cellData
    const isActiveCell = activeKey === key
    return (
      <Animated.View style={style}>
        <Animated.View
          pointerEvents={activeKey ? 'none' : 'auto'}
          style={{
            flexDirection: horizontal ? 'row' : 'column',
          }}
        >
          <Animated.View
            ref={ref}
            onLayout={onCellLayout}
            style={isActiveCell ? { opacity: 0 } : undefined}
          >
            <RowItem
              extraData={this.props.extraData}
              itemKey={key}
              keyToIndex={this.keyToIndex}
              renderItem={this.props.renderItem}
              item={item.item}
              drag={this.drag}
              onUnmount={onUnmount}
            />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    )
  }

  renderOnPlaceholderIndexChange = () => (
    <Animated.Code>
      {() =>
        block([
          onChange(
            this.spacerIndex,
            call([this.spacerIndex], ([spacerIndex]) =>
              this.props.onPlaceholderIndexChange!(spacerIndex)
            )
          ),
        ])
      }
    </Animated.Code>
  )

  renderPlaceholder = () => {
    const { renderPlaceholder, horizontal } = this.props
    const { activeKey } = this.state
    if (!activeKey || !renderPlaceholder) return null
    const activeIndex = this.keyToIndex.get(activeKey)
    if (activeIndex === undefined) return null
    const activeItem = this.props.data[activeIndex]
    const translateKey = horizontal ? 'translateX' : 'translateY'
    const sizeKey = horizontal ? 'width' : 'height'
    const style = {
      ...StyleSheet.absoluteFillObject,
      [sizeKey]: this.activeCellSize,
      transform: [
        { [translateKey]: this.placeholderPos },
      ] as Animated.AnimatedTransform,
    }

    return (
      <Animated.View style={style}>
        {renderPlaceholder({ item: activeItem, index: activeIndex })}
      </Animated.View>
    )
  }

  renderDebug() {
    return (
      <Animated.Code>
        {() =>
          block([
            onChange(
              this.spacerIndex,
              debug('spacerIndex: ', this.spacerIndex)
            ),
          ])
        }
      </Animated.Code>
    )
  }

  onContainerTouchEnd = () => {
    this.isPressedIn.native.setValue(0)
  }

  render() {
    const {
      dragHitSlop,
      scrollEnabled,
      debug,
      horizontal,
      activationDistance,
      onScrollOffsetChange,
      renderPlaceholder,
      onPlaceholderIndexChange,
    } = this.props

    const { hoverComponent } = this.state
    let dynamicProps = {}
    if (activationDistance) {
      const activeOffset = [-activationDistance, activationDistance]
      dynamicProps = horizontal
        ? { activeOffsetX: activeOffset }
        : { activeOffsetY: activeOffset }
    }
    return (
      <PanGestureHandler
        ref={this.panGestureHandlerRef}
        hitSlop={dragHitSlop}
        onGestureEvent={this.onPanGestureEvent}
        onHandlerStateChange={this.onPanStateChange}
        {...dynamicProps}
      >
        <Animated.View
          style={styles.flex}
          ref={this.containerRef}
          onLayout={this.onContainerLayout}
          onTouchEnd={this.onContainerTouchEnd}
        >
          {!!onPlaceholderIndexChange && this.renderOnPlaceholderIndexChange()}
          {!!renderPlaceholder && this.renderPlaceholder()}
          <AnimatedSectionList
            {...this.props}
            sections={this.props.data}
            ref={this.SectionListRef}
            onContentSizeChange={this.onListContentSizeChange}
            renderItem={this.renderItem}
            renderSectionHeader={this.renderSectionHeader}
            extraData={this.state}
            keyExtractor={this.keyExtractor}
            scrollEnabled={!hoverComponent && scrollEnabled}
            onScroll={this.onScroll}
            scrollEventThrottle={1}
          />
          {!!hoverComponent && this.renderHoverComponent()}
          <Animated.Code>
            {() =>
              block([
                onChange(
                  this.isPressedIn.native,
                  cond(not(this.isPressedIn.native), this.onGestureRelease)
                ),
                onChange(this.touchAbsolute, this.checkAutoscroll),
                cond(clockRunning(this.hoverClock), [
                  spring(
                    this.hoverClock,
                    this.hoverAnimState,
                    this.hoverAnimConfig
                  ),
                  cond(eq(this.hoverAnimState.finished, 1), [
                    stopClock(this.hoverClock),
                    call(this.moveEndParams, this.onDragEnd),
                    this.resetHoverSpring,
                    set(this.hasMoved, 0),
                  ]),
                ]),
              ])
            }
          </Animated.Code>
          {onScrollOffsetChange && (
            <Animated.Code>
              {() =>
                onChange(
                  this.scrollOffset,
                  call([this.scrollOffset], ([offset]) =>
                    onScrollOffsetChange(offset)
                  )
                )
              }
            </Animated.Code>
          )}
          {debug && this.renderDebug()}
        </Animated.View>
      </PanGestureHandler>
    )
  }
}

export default DraggableSectionList

type RowSectionProps<T> = {
  extraData?: any
  drag: (hoverComponent: React.ReactNode, itemKey: string) => void
  keyToIndex: Map<string, number>
  item: RenderItemParams<T>
  renderSectionHeader: (params: RenderItemParams<T>) => React.ReactNode
  itemKey: string
  onUnmount: () => void
  debug?: boolean
}

type RowItemProps<T> = {
  extraData?: any
  drag: (hoverComponent: React.ReactNode, itemKey: string) => void
  keyToIndex: Map<string, number>
  item: T
  renderItem: (params: RenderItemParams<T>) => React.ReactNode
  itemKey: string
  onUnmount: () => void
  debug?: boolean
}

class RowItem<T> extends React.PureComponent<RowItemProps<T>> {
  drag = () => {
    const { drag, renderItem, item, keyToIndex, itemKey, debug } = this.props
    const hoverComponent = renderItem({
      isActive: true,
      item,
      index: keyToIndex.get(itemKey),
      drag: () => {
        if (debug)
          console.log('## attempt to call drag() on hovering component')
      },
    })
    drag(hoverComponent, itemKey)
  }

  componentWillUnmount() {
    this.props.onUnmount()
  }

  render() {
    const { renderItem, item, keyToIndex, itemKey } = this.props
    return renderItem({
      isActive: false,
      item,
      index: keyToIndex.get(itemKey),
      drag: this.drag,
    })
  }
}

class RowSection<T> extends React.PureComponent<RowSectionProps<T>> {
  drag = () => {
    const {
      drag,
      renderSectionHeader,
      item,
      keyToIndex,
      itemKey,
      debug,
    } = this.props
    const hoverComponent = renderSectionHeader({
      isActive: true,
      item,
      index: keyToIndex.get(itemKey),
      drag: () => {
        if (debug)
          console.log('## attempt to call drag() on hovering component')
      },
    })
    drag(hoverComponent, itemKey)
  }

  componentWillUnmount() {
    this.props.onUnmount()
  }

  render() {
    const { renderSectionHeader, item, keyToIndex, itemKey } = this.props
    return renderSectionHeader({
      isActive: false,
      item,
      index: keyToIndex.get(itemKey),
      drag: this.drag,
    })
  }
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  hoverComponentVertical: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  hoverComponentHorizontal: {
    position: 'absolute',
    bottom: 0,
    top: 0,
  },
})

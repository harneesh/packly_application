import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  StyleSheet,
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Text,
  TextInput,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from 'expo-audio';
import { Animated, Easing } from 'react-native';

// ──────────────────────────────────────────
// ExamplePhrases: right-to-left sliding ticker shown under the mic button.
// Music-style italics, endless loop, pauses briefly between phrases.
// ──────────────────────────────────────────
import ScreenHeader from '../../../packly-ui/components/ScreenHeader';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, font, radius, shadow, fonts } from '../../../packly-ui/theme';
import { supabase } from '@/services/supabase';
import { processAudio } from '@/services/voice';
import { fetchCreditBalance } from '@/services/credits';
import { useMoveCreditPool } from '@/hooks/use-move-plan';
import ConfirmModal from '@/components/confirm-modal';
import ModalBackdrop from '@/components/modal-backdrop';
import LabelPromptModal from '@/components/label-prompt-modal';
import BoxPhotos from '@/components/box-photos';
import SectionHeader from '../../../packly-ui/components/SectionHeader';
import { fetchRoom, ROOM_STALE_MS } from '@/services/rooms';
import { fetchPhotos } from '@/services/photos';
import BottomSheet, { BottomSheetDraggableArea } from '@/components/bottom-sheet';
import { toFriendlyError } from '@/lib/errors';
import { useRef, useState, useEffect, useCallback } from 'react';
import { BackHandler } from 'react-native';
import { useAuthStore } from '@/store/auth-store';



import type { Box, Item } from '@/types/database';

// ──────────────────────────────────────────
// Recording waveform: animated bars
// ──────────────────────────────────────────

function RecordingWaveform() {
  const heights = [
    useRef(new Animated.Value(0.4)).current,
    useRef(new Animated.Value(1)).current,
    useRef(new Animated.Value(0.6)).current,
    useRef(new Animated.Value(0.8)).current,
    useRef(new Animated.Value(0.3)).current,
  ];

  useEffect(() => {
    const animations = heights.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(anim, { toValue: 1, duration: 400 + i * 80, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0.3, duration: 400 + i * 80, useNativeDriver: true }),
        ]),
      ),
    );
    const parallel = Animated.parallel(animations);
    parallel.start();
    return () => parallel.stop();
  }, []);

  return (
    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center', height: 32 }}>
      {heights.map((anim, i) => (
        <Animated.View
          key={i}
          style={{
            width: 4,
            height: 28,
            borderRadius: 2,
            backgroundColor: colors.accent,
            opacity: anim,
            transform: [{ scaleY: anim }],
          }}
        />
      ))}
    </View>
  );
}

// ──────────────────────────────────────────
// ExamplePhrases: right-to-left sliding ticker shown under the mic button.
// Music-style italics; phrases cycle endlessly with a short pause between.
// ──────────────────────────────────────────

const EXAMPLE_PHRASES = [
  'I am packing water bottles, kettles and utensils…',
  'Packing bedsheets, pillows and winter blankets…',
  'Packing notebooks, pens, stapler and tape…',
];

function ExamplePhrases() {
  const translateX = useRef(new Animated.Value(0)).current;
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [trackW, setTrackW] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let anim: Animated.CompositeAnimation | null = null;

    const runPhrase = (index: number) => {
      if (cancelled) return;
      setPhraseIdx(index % EXAMPLE_PHRASES.length);
      translateX.setValue(0);
      anim = Animated.sequence([
        // Slide the phrase fully across the track, then a beat of silence
        Animated.timing(translateX, {
          toValue: 1,
          duration: 9000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.delay(600),
      ]);
      anim.start(({ finished }) => {
        if (finished && !cancelled) runPhrase(index + 1);
      });
    };

    runPhrase(0);
    return () => {
      cancelled = true;
      anim?.stop();
    };
  }, [translateX]);

  // Entry/exit bounds measured from the track so the phrase always starts
  // fully off the right edge and exits fully past the left on any device.
  const slideX = translateX.interpolate({
    inputRange: [0, 1],
    outputRange: [trackW + 24, -420],
  });

  return (
    <View style={styles.phraseTrack} onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}>
      <Animated.Text
        style={[styles.phraseText, { transform: [{ translateX: slideX }] }]}>
        {EXAMPLE_PHRASES[phraseIdx]}
      </Animated.Text>
    </View>
  );
}

// ──────────────────────────────────────────
// Data fetching
// ──────────────────────────────────────────

async function fetchBox(id: string): Promise<Box> {
  const { data, error } = await supabase
    .from('boxes')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function fetchItems(boxId: string): Promise<Item[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('box_id', boxId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

// Module-level channel counter for the items realtime subscription.
// Must be module scope (NOT a useRef): useRef resets when this screen remounts,
// which could reuse a channel name whose previous channel's async removeChannel()
// has not yet completed — supabase.channel() then returns the already-subscribed
// channel and .on() throws "cannot add postgres_changes callbacks ... after subscribe()".
// Do not move this into the component or remove the counter.
let boxItemChannelSeq = 0;

export default function BoxDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const {
    data: box,
    isLoading: boxLoading,
    error: boxError,
  } = useQuery({
    queryKey: ['box', id],
    queryFn: () => fetchBox(id!),
    enabled: !!id,
  });

  const {
    data: items,
    isLoading: itemsLoading,
  } = useQuery({
    queryKey: ['items', id],
    queryFn: () => fetchItems(id!),
    enabled: !!id,
  });

  // Room name for the header subtitle ("Bathroom, 8 items"). Shares the
  // ['room', id] cache entry with the Room screen, so navigating Room → Box
  // paints the subtitle instantly instead of round-tripping.
  const { data: room } = useQuery({
    queryKey: ['room', box?.room_id],
    queryFn: () => fetchRoom(box!.room_id),
    enabled: !!box?.room_id,
    staleTime: ROOM_STALE_MS,
  });

  // ── AI credits (1 credit = 1 voice recording) ──
  // Cached for a minute; updated optimistically after each recording and
  // refetched when the server reports OUT_OF_CREDITS.
  const { data: credits } = useQuery({
    queryKey: ['credits'],
    queryFn: fetchCreditBalance,
    staleTime: 60 * 1000,
  });
  const creditsRemaining = credits?.balance ?? null;

  // Pro is shared with the move: the server spends the move's pooled Pro
  // credits BEFORE this user's own, so the recordings actually available here
  // are the personal balance plus whatever a covering member contributed. A
  // member with no credits of their own can still record inside a Pro move.
  const { pool: sharedCreditPool } = useMoveCreditPool(room?.move_id);
  const availableCredits =
    creditsRemaining === null ? null : creditsRemaining + (sharedCreditPool ?? 0);
  const outOfCredits = availableCredits === 0;

  // ── Photo count — shares the ['box-photos', id] cache entry BoxPhotos
  // populates below, so it costs no extra request. Drives the delete
  // confirmation, which only mentions photos when the box actually has some.
  const { data: boxPhotos } = useQuery({
    queryKey: ['box-photos', id],
    queryFn: () => fetchPhotos(id!),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });
  const boxPhotoCount = boxPhotos?.length ?? 0;

  const inputRef = useRef<TextInput>(null);
  const editRef = useRef<TextInput>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [itemName, setItemName] = useState('');
  const [addItemError, setAddItemError] = useState<string | null>(null);
  const [isAddingItem, setIsAddingItem] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [editItemName, setEditItemName] = useState('');
  const [editItemError, setEditItemError] = useState<string | null>(null);
  const [isEditingItem, setIsEditingItem] = useState(false);

  const [voiceState, setVoiceState] = useState<
    'idle' | 'requesting' | 'recording' | 'processing' | 'done' | 'error'
  >('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [extractedItems, setExtractedItems] = useState<string[]>([]);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingMaxReached, setRecordingMaxReached] = useState(false);
  const recordingAttemptsRef = useRef(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const MAX_RECORDING_SECONDS = 45;
  const MAX_RECORDING_ATTEMPTS = 3;

  // ── Review modal state ──
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewItems, setReviewItems] = useState<string[]>([]);
  const [editingReviewIdx, setEditingReviewIdx] = useState<number | null>(null);
  const [editingReviewValue, setEditingReviewValue] = useState('');
  const [showReviewAdd, setShowReviewAdd] = useState(false);
  const [reviewAddValue, setReviewAddValue] = useState('');

  const [isSavingReview, setIsSavingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewAddRef = useRef<TextInput>(null);

  // ── Label prompt state ──
  const [showLabelPrompt, setShowLabelPrompt] = useState(false);
  const [isSettingLabel, setIsSettingLabel] = useState(false);

  // ── Box action sheet (moved from Home rows; opens from the header ⋯) ──
  const [showBoxSheet, setShowBoxSheet] = useState(false);
  const [editingBox, setEditingBox] = useState<Box | null>(null);
  const [editBoxName, setEditBoxName] = useState('');
  const [editBoxError, setEditBoxError] = useState<string | null>(null);
  const [isEditingBox, setIsEditingBox] = useState(false);
  const editBoxRef = useRef<TextInput>(null);
  const [deleteConfirmBox, setDeleteConfirmBox] = useState<Box | null>(null);
  const [isDeletingBox, setIsDeletingBox] = useState(false);
  const [deleteBoxErrorVisible, setDeleteBoxErrorVisible] = useState(false);

  // ── Show label prompt when box loads and label is not written ──
  useEffect(() => {
    if (box && !box.label_written && !boxLoading) {
      setShowLabelPrompt(true);
    }
  }, [box, boxLoading]);

  const handleWroteIt = useCallback(async () => {
    if (!id) return;
    setIsSettingLabel(true);
    try {
      const { error } = await supabase
        .from('boxes')
        .update({ label_written: true })
        .eq('id', id);

      if (error) throw new Error(error.message);

      setShowLabelPrompt(false);
      queryClient.invalidateQueries({ queryKey: ['box', id] });
    } catch (err) {
      console.error('Failed to update label status:', err);
      // Still show the prompt so user can retry
    } finally {
      setIsSettingLabel(false);
    }
  }, [id, queryClient]);

  const handleSkipLabel = useCallback(() => {
    router.back();
  }, []);

  // ── Box rename/delete (moved from the Home row ⋯ sheet) ──
  // Uses the room id from the loaded box so cache invalidation works the
  // same way it did on Home (roomBoxes / boxes queries).
  const handleRenameBox = useCallback(async () => {
    if (!editingBox || !id) return;

    const trimmed = editBoxName.trim();
    if (!trimmed) {
      setEditBoxError('Box label is required.');
      return;
    }

    setEditBoxError(null);
    setIsEditingBox(true);

    try {
      const { error } = await supabase
        .from('boxes')
        .update({ box_number: trimmed })
        .eq('id', editingBox.id);

      if (error) {
        if (error.message?.includes('duplicate key') || error.message?.includes('unique constraint')) {
          throw new Error(`A box with label "${trimmed}" already exists in this room.`);
        }
        throw new Error(error.message);
      }

      setEditingBox(null);
      setEditBoxName('');
      queryClient.invalidateQueries({ queryKey: ['box', id] });
      queryClient.invalidateQueries({ queryKey: ['roomBoxes', editingBox.room_id] });
      queryClient.invalidateQueries({ queryKey: ['boxes', editingBox.room_id] });
    } catch (err) {
      setEditBoxError(toFriendlyError(err, 'Failed to rename box.'));
    } finally {
      setIsEditingBox(false);
    }
  }, [editingBox, editBoxName, id, queryClient]);

  const performDeleteBox = useCallback(async () => {
    if (!deleteConfirmBox || !id) return;
    setIsDeletingBox(true);

    try {
      // Remove storage files BEFORE the DB cascade deletes the box row
      // (storage DELETE RLS requires the box to exist) — same order Home used.
      const { deleteStorageForBoxIds } = await import('@/services/photos');
      await deleteStorageForBoxIds([deleteConfirmBox.id]);

      const { error } = await supabase
        .from('boxes')
        .delete()
        .eq('id', deleteConfirmBox.id);

      if (error) throw new Error(error.message);

      setDeleteConfirmBox(null);
      queryClient.invalidateQueries({ queryKey: ['roomBoxes', deleteConfirmBox.room_id] });
      queryClient.invalidateQueries({ queryKey: ['boxes', deleteConfirmBox.room_id] });
      // Home's progress card tallies boxes for the whole move.
      queryClient.invalidateQueries({ queryKey: ['moveProgress'] });
      router.back();
    } catch {
      setDeleteConfirmBox(null);
      setDeleteBoxErrorVisible(true);
    } finally {
      setIsDeletingBox(false);
    }
  }, [deleteConfirmBox, id, queryClient]);

  // ── Focus rename input when the modal opens ──
  useEffect(() => {
    if (editingBox) {
      const timer = setTimeout(() => {
        editBoxRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [editingBox]);

  // ── Auto-open review modal when items are extracted ──
  useEffect(() => {
    if (voiceState === 'done' && extractedItems.length > 0) {
      setReviewItems([...extractedItems]);
      setShowReviewModal(true);
    } else if (voiceState === 'done' && extractedItems.length === 0) {
      // No items detected — stay on the done card, user can tap "Record again"
      setShowReviewModal(false);
    }
  }, [voiceState, extractedItems]);

  // ── Audio recorder ──
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  // ── Timer for recording duration ──
  useEffect(() => {
    if (voiceState === 'recording') {
      setRecordingSeconds(0);
      setRecordingMaxReached(false);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } else {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    }
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
    };
  }, [voiceState]);

  // ── Auto-stop at MAX_RECORDING_SECONDS ──
  useEffect(() => {
    if (
      voiceState === 'recording' &&
      recordingSeconds >= MAX_RECORDING_SECONDS
    ) {
      setRecordingMaxReached(true);
      stopAndProcessRecording();
    }
  }, [recordingSeconds, voiceState]);

  // ── Cleanup on unmount — stop any active recording, clear timer ──
  useEffect(() => {
    return () => {
      // stop() returns a promise that can reject if the native recorder was already released
      if (audioRecorder && voiceState === 'recording') {
        audioRecorder.stop().catch(() => {});
      }
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
      setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    };
  }, [audioRecorder, voiceState]);

  // ── Voice recording handlers ──

  // ── Custom confirm/error modal state ──
  const [cancelConfirmVisible, setCancelConfirmVisible] = useState(false);
  const [cancelLeaveCallback, setCancelLeaveCallback] = useState<(() => void) | null>(null);
  const [deleteConfirmItem, setDeleteConfirmItem] = useState<Item | null>(null);
  const [deleteErrorVisible, setDeleteErrorVisible] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // ── Navigate back with recording confirmation ──
  const handleBack = useCallback(() => {
    if (voiceState === 'recording' || voiceState === 'requesting') {
      setCancelLeaveCallback(() => () => router.back());
      setCancelConfirmVisible(true);
    } else {
      router.back();
    }
  }, [voiceState]);

  // ── Android hardware back button ──
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (voiceState === 'recording' || voiceState === 'requesting') {
        setCancelLeaveCallback(() => () => router.back());
        setCancelConfirmVisible(true);
        return true; // Prevent default back
      }
      return false; // Let default back happen
    });
    return () => sub.remove();
  }, [voiceState]);

  const startRecording = useCallback(async () => {
    if (availableCredits === 0) {
      setVoiceError('You are out of AI credits.');
      setVoiceState('error');
      return;
    }

    if (recordingAttemptsRef.current >= MAX_RECORDING_ATTEMPTS) {
      setVoiceError(`Maximum recording attempts reached (${MAX_RECORDING_ATTEMPTS}/${MAX_RECORDING_ATTEMPTS}). Add items manually instead.`);
      setVoiceState('error');
      return;
    }

    setVoiceError(null);
    setVoiceState('requesting');

    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setVoiceError(
          'Microphone access is required to record your voice. ' +
            'Please enable microphone access in your device settings and try again.',
        );
        setVoiceState('error');
        return;
      }

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      recordingAttemptsRef.current += 1;
      setVoiceState('recording');
    } catch (err) {
      console.error('Failed to start recording:', err);
      setVoiceError('Unable to start recording. Please try again.');
      setVoiceState('error');
    }
  }, [audioRecorder, availableCredits]);

  const stopAndProcessRecording = useCallback(async () => {
    if (!id) return;

    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;

      if (!uri) {
        setVoiceError('No recording was captured. Please try again.');
        setVoiceState('error');
        return;
      }

      setVoiceState('processing');

      await setAudioModeAsync({ allowsRecording: false });

      // Pass the box so the server can bill the move's shared Pro pool first.
      const result = await processAudio(uri, id);

      if (result.success) {
        setExtractedItems(result.items);
        setVoiceState('done');
        // The server reports the total available for this recording, which may
        // be the move's shared pool rather than this user's own balance — so
        // refetch instead of writing the number straight into the personal
        // balance cache.
        if (typeof result.creditsRemaining === 'number') {
          queryClient.invalidateQueries({ queryKey: ['credits'] });
        }
      } else {
        if (result.code === 'OUT_OF_CREDITS') {
          // The cached balance was stale — refetch so the UI gates correctly.
          queryClient.invalidateQueries({ queryKey: ['credits'] });
        }
        setVoiceError(result.error);
        setVoiceState('error');
      }
    } catch (err) {
      console.error('Failed to process recording:', err);
      setVoiceError('Unable to process the recording. Please try again.');
      setVoiceState('error');
    }
  }, [id, audioRecorder, queryClient]);

  // ── Review modal handlers ──

  const handleConfirmReview = useCallback(async () => {
    if (!id || !user || reviewItems.length === 0) return;

    setReviewError(null);
    setIsSavingReview(true);

    try {
      const { error } = await supabase.from('items').insert(
        reviewItems.map((name) => ({
          box_id: id,
          name: name.trim(),
          created_by: user.id,
        })),
      );

      if (error) throw new Error(error.message);

      setShowReviewModal(false);
      setReviewItems([]);
      setExtractedItems([]);
      setVoiceState('idle');
      queryClient.invalidateQueries({ queryKey: ['items', id] });


    } catch (err) {
      setReviewError(toFriendlyError(err, 'Failed to save items.'));
    } finally {
      setIsSavingReview(false);
    }
  }, [id, user, reviewItems, queryClient]);

  const handleCancelReview = useCallback(() => {
    setShowReviewModal(false);
    setReviewItems([]);
    setExtractedItems([]);
    setEditingReviewIdx(null);
    setEditingReviewValue('');
    setShowReviewAdd(false);
    setReviewAddValue('');
    setReviewError(null);
    setVoiceState('idle');
  }, []);

  const handleRemoveReviewItem = useCallback((index: number) => {
    setReviewItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleStartEditReviewItem = useCallback((index: number) => {
    setEditingReviewIdx(index);
    setEditingReviewValue(reviewItems[index]);
  }, [reviewItems]);

  const handleFinishEditReviewItem = useCallback(() => {
    if (editingReviewIdx !== null && editingReviewValue.trim()) {
      setReviewItems((prev) => {
        const updated = [...prev];
        updated[editingReviewIdx] = editingReviewValue.trim();
        return updated;
      });
    }
    setEditingReviewIdx(null);
    setEditingReviewValue('');
  }, [editingReviewIdx, editingReviewValue]);

  const handleAddReviewItem = useCallback(() => {
    const trimmed = reviewAddValue.trim();
    if (trimmed) {
      setReviewItems((prev) => [...prev, trimmed]);
      setReviewAddValue('');
    }
  }, [reviewAddValue]);

  // ── Focus add input when shown ──
  useEffect(() => {
    if (showReviewAdd) {
      const timer = setTimeout(() => reviewAddRef.current?.focus(), 100);
      return () => clearTimeout(timer);
    }
  }, [showReviewAdd]);

  /** Format seconds as MM:SS */
  const formatTime = (totalSeconds: number): string => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // ── Realtime subscription — auto-refresh items when another member makes a change ──
  // Channel name includes a module-level counter so each effect run gets a fresh name.
  useEffect(() => {
    if (!id) return;

    const seq = ++boxItemChannelSeq;
    const channel = supabase
      .channel(`box-${id}-items-${seq}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'items', filter: `box_id=eq.${id}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['items', id] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, queryClient]);

  // ── Focus input when modal opens ──
  useEffect(() => {
    if (showAddItem) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [showAddItem]);

  useEffect(() => {
    if (editingItem) {
      const timer = setTimeout(() => {
        editRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [editingItem]);

  const handleAddItem = async () => {
    if (!id || !user) return;

    const trimmed = itemName.trim();
    if (!trimmed) {
      setAddItemError('Item name is required.');
      return;
    }

    setAddItemError(null);
    setIsAddingItem(true);

    try {
      const { error } = await supabase
        .from('items')
        .insert({
          box_id: id,
          name: trimmed,
          created_by: user.id,
        });

      if (error) throw new Error(error.message);

      setItemName('');
      setShowAddItem(false);
      queryClient.invalidateQueries({ queryKey: ['items', id] });
    } catch (err) {
      setAddItemError(toFriendlyError(err, 'Failed to add item.'));
    } finally {
      setIsAddingItem(false);
    }
  };



  const handleDeleteItem = async (item: Item) => {
    setDeleteConfirmItem(item);
  };

  const performDeleteItem = useCallback(async () => {
    if (!deleteConfirmItem || !id) return;
    setIsDeleting(true);

    try {
      const { error } = await supabase
        .from('items')
        .delete()
        .eq('id', deleteConfirmItem.id);

      if (error) throw new Error(error.message);

      setDeleteConfirmItem(null);
      queryClient.invalidateQueries({ queryKey: ['items', id] });
    } catch {
      setDeleteConfirmItem(null);
      setDeleteErrorVisible(true);
    } finally {
      setIsDeleting(false);
    }
  }, [deleteConfirmItem, id, queryClient]);

  const handleRenameItem = async () => {
    if (!editingItem || !id) return;

    const trimmed = editItemName.trim();
    if (!trimmed) {
      setEditItemError('Item name is required.');
      return;
    }

    setEditItemError(null);
    setIsEditingItem(true);

    try {
      const { error } = await supabase
        .from('items')
        .update({ name: trimmed })
        .eq('id', editingItem.id);

      if (error) throw new Error(error.message);

      setEditingItem(null);
      setEditItemName('');
      queryClient.invalidateQueries({ queryKey: ['items', id] });
    } catch (err) {
      setEditItemError(toFriendlyError(err, 'Failed to rename item.'));
    } finally {
      setIsEditingItem(false);
    }
  };

  // ── Loading ─────────────────────────────
  if (boxLoading) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <SafeAreaView style={styles.centeredSafeArea}>
          <ActivityIndicator size="large" color={colors.primary} />
        </SafeAreaView>
      </View>
    );
  }

  // ── Error ──────────────────────────────
  if (boxError || !box) {
    return (
      <View style={[styles.container, styles.centeredContainer]}>
        <SafeAreaView style={styles.centeredSafeArea}>
          <Text style={[font.body, { color: colors.textSecondary, textAlign: 'center' }]}>
            Could not load box details.
          </Text>
          <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.7 }]}>
            <Text style={{ color: colors.primary }}>Go Back</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  // ── Item count — drives the header subtitle (mockup: "Bathroom, 8 items") ──
  const itemCount = items?.length ?? 0;
  const itemCountLabel = `${itemCount} item${itemCount === 1 ? '' : 's'}`;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.container}>
        <ScreenHeader
          onBack={handleBack}
          title={box.box_number}
          subtitle={room?.name ? `${room.name}, ${itemCountLabel}` : itemCountLabel}
          large
          right={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Box options"
              onPress={() => setShowBoxSheet(true)}
              hitSlop={8}
              style={({ pressed }) => [styles.headerAction, pressed && { opacity: 0.6 }]}>
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.textPrimary} />
            </Pressable>
          }
        />

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>

          {/* ── Voice Section ──────────────────── */}
          <View>
            <SectionHeader icon="mic-outline" title="Voice" style={{ paddingHorizontal: spacing.xl }} />

          {voiceState === 'idle' && (
            <View style={styles.heroCard}>
              {/* Indigo mic disc inside a soft halo (mockup: the hero of the
                  Box screen). Tap = start recording, same handler as before. */}
              <Pressable
                onPress={startRecording}
                disabled={outOfCredits}
                accessibilityRole="button"
                accessibilityLabel="Start recording"
                style={({ pressed }) => [
                  styles.micHalo,
                  pressed && { transform: [{ scale: 0.97 }] },
                  outOfCredits && styles.micHaloDisabled,
                ]}>
                <View style={[styles.micButton, outOfCredits && styles.micButtonDisabled]}>
                  {/* Ink mic on the accent disc — same yellow-is-for-icons
                      language as Home's move tiles. */}
                  <Ionicons name="mic" size={44} color={colors.navyDeep} />
                </View>
              </Pressable>
              <Text style={styles.heroTitle}>Tap and say what you packed</Text>
              <ExamplePhrases />
              {availableCredits !== null && (
                <Pressable
                  // Out of recordings → the pill becomes the way to the paywall.
                  disabled={!outOfCredits}
                  onPress={() => router.push('/paywall')}
                  style={[
                    styles.creditsPill,
                    outOfCredits && { backgroundColor: colors.dangerSoft },
                  ]}>
                  <Text
                    style={[styles.creditsPillText, outOfCredits && { color: colors.danger }]}>
                    {outOfCredits
                      ? 'Upgrade to Pro for more recordings'
                      : `${availableCredits} recording${availableCredits !== 1 ? 's' : ''} left`}
                  </Text>
                </Pressable>
              )}
              {sharedCreditPool !== null && sharedCreditPool > 0 ? (
                <Text style={styles.sharedCreditsHint}>
                  {sharedCreditPool} of these are shared with this move by a Pro member
                </Text>
              ) : null}
            </View>
          )}

          {voiceState === 'requesting' && (
            <View style={styles.heroCard}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.statusText}>Preparing microphone...</Text>
            </View>
          )}

          {voiceState === 'recording' && (
            <View style={[styles.heroCard, styles.heroCardRecording]}>
              <View style={styles.micButtonActive}>
                <Ionicons name="mic" size={52} color={colors.navyDeep} />
              </View>
              <RecordingWaveform />
              <Text style={styles.recordingTimer}>{formatTime(recordingSeconds)}</Text>
              <Text style={styles.listeningText}>Listening...</Text>
              {!recordingMaxReached && (
                <Pressable
                  onPress={stopAndProcessRecording}
                  style={({ pressed }) => [
                    styles.stopButton,
                    pressed && { opacity: 0.8 },
                  ]}>
                  <Text style={styles.stopButtonText}>■ Stop Recording</Text>
                </Pressable>
              )}
              {recordingMaxReached && (
                <Text style={styles.autoStoppedText}>Time limit reached. Processing...</Text>
              )}
            </View>
          )}

          {voiceState === 'processing' && (
            <View style={styles.heroCard}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.statusText}>AI is organizing your items...</Text>
            </View>
          )}

          {voiceState === 'done' && (
            <View style={[styles.heroCard, styles.heroCardDone]}>
              <Ionicons name="checkmark-circle" size={48} color={colors.success} />
              <Text style={styles.doneTitle}>
                {extractedItems.length > 0
                  ? `${extractedItems.length} item${extractedItems.length !== 1 ? 's' : ''} detected`
                  : 'No items detected'}
              </Text>
              {extractedItems.length > 0 && (
                <View style={styles.extractedPreview}>
                  {extractedItems.slice(0, 3).map((item, i) => (
                    <Text key={i} style={styles.extractedItem}>{item}</Text>
                  ))}
                  {extractedItems.length > 3 && (
                    <Text style={styles.extractedMore}>
                      ...and {extractedItems.length - 3} more
                    </Text>
                  )}
                </View>
              )}
              <Pressable
                onPress={() => setVoiceState('idle')}
                style={({ pressed }) => [
                  styles.recordAgainBtn,
                  pressed && { opacity: 0.7 },
                ]}>
                <Text style={styles.recordAgainText}>Record again</Text>
              </Pressable>
            </View>
          )}

          {voiceState === 'error' && (
            <View style={[styles.heroCard, { backgroundColor: colors.dangerSoft }]}>
              <Ionicons name="alert-circle-outline" size={40} color={colors.danger} />
              <Text style={styles.errorTitle}>Recording Failed</Text>
              {voiceError && (
                <Text style={styles.errorText}>{voiceError}</Text>
              )}
              <View style={styles.errorActions}>
                <Pressable
                  onPress={() => setVoiceState('idle')}
                  style={({ pressed }) => [
                    styles.dismissBtn,
                    pressed && { opacity: 0.7 },
                  ]}>
                  <Text style={styles.dismissBtnText}>Dismiss</Text>
                </Pressable>
                <Pressable
                  onPress={startRecording}
                  style={({ pressed }) => [
                    styles.tryAgainBtn,
                    pressed && { opacity: 0.7 },
                  ]}>
                  <Text style={styles.tryAgainBtnText}>Try Again</Text>
                </Pressable>
              </View>
            </View>
          )}
          </View>

          {/* ── Photos Section ─────────────────────── */}
          <BoxPhotos boxId={id} moveId={room?.move_id} />

          {/* ── Items Section ──────────────────────── */}
          <View style={styles.itemsSection}>
            {/* No extra horizontal padding: itemsSection already pads, so the
                header lines up with the left edge of the item cards. */}
            <SectionHeader title="Items" meta={`${items?.length ?? 0}`} />

            {itemsLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : items && items.length > 0 ? (
              /* One white card per item (mockup: separate rounded rows) */
              <View style={styles.itemsList}>
                {items.map((item) => (
                  <View key={item.id} style={styles.itemRow}>
                    <View style={styles.itemDot}>
                      <Ionicons name="cube-outline" size={18} color={colors.item} />
                    </View>
                    <Text style={styles.itemName} numberOfLines={1} ellipsizeMode="tail">
                      {item.name}
                    </Text>
                    <View style={styles.itemActions}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Rename ${item.name}`}
                        onPress={() => {
                          setEditItemName(item.name);
                          setEditItemError(null);
                          setEditingItem(item);
                        }}
                        style={({ pressed }) => [
                          styles.itemActionBtn,
                          pressed && { opacity: 0.6 },
                        ]}>
                        <Ionicons name="pencil-outline" size={18} color={colors.textSecondary} />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${item.name}`}
                        onPress={() => handleDeleteItem(item)}
                        style={({ pressed }) => [
                          styles.itemActionBtn,
                          pressed && { opacity: 0.6 },
                        ]}>
                        <Ionicons name="trash-outline" size={18} color={colors.danger} />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconContainer}>
                  <Ionicons name="cube-outline" size={26} color={colors.accentDeep} />
                </View>
                <Text style={styles.emptyTitle}>No items yet</Text>
                <Text style={styles.emptyDescription}>
                  Record your voice or add items manually.
                </Text>
                <Pressable
                  onPress={() => setShowAddItem(true)}
                  style={({ pressed }) => [
                    styles.emptyAddBtn,
                    pressed && { opacity: 0.85 },
                  ]}>
                  <Ionicons name="add" size={18} color={colors.textInverse} />
                  <Text style={styles.emptyAddText}>Add first item</Text>
                </Pressable>
              </View>
            )}
          </View>
        </ScrollView>

        {/* ── Floating Add Button (always visible) ── */}
        <Pressable
          onPress={() => setShowAddItem(true)}
          style={({ pressed }) => [
            styles.fab,
            pressed && { transform: [{ scale: 0.96 }] },
          ]}>
          <Ionicons name="add" size={22} color={colors.textInverse} />
          <Text style={styles.fabText}>Add item</Text>
        </Pressable>
      </View>

      {/* ── Add Item Modal ──────────────────── */}
      <Modal
        visible={showAddItem}
        transparent
        animationType="none"
        onRequestClose={() => {
          setShowAddItem(false);
          setItemName('');
          setAddItemError(null);
        }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding">
          <ModalBackdrop
            visible={showAddItem}
            onBackdropPress={() => {
              setShowAddItem(false);
              setItemName('');
              setAddItemError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <View style={styles.modalTitleRow}>
                <View style={styles.modalTitleIcon}>
                  <Ionicons name="cube-outline" size={18} color={colors.primary} />
                </View>
                <Text style={font.title}>Add Item</Text>
              </View>

              {addItemError ? (
                <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 13 }}>{addItemError}</Text>
                </View>
              ) : null}

              <TextInput
                ref={inputRef}
                style={styles.itemInput}
                placeholder="Item name (e.g. Coffee Maker)"
                placeholderTextColor={colors.textTertiary}
                value={itemName}
                onChangeText={(text) => {
                  setItemName(text);
                  if (addItemError) setAddItemError(null);
                }}
                editable={!isAddingItem}
                returnKeyType="done"
                onSubmitEditing={handleAddItem}
                maxLength={100}
              />

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setShowAddItem(false);
                    setItemName('');
                    setAddItemError(null);
                  }}
                  style={({ pressed }) => [styles.modalPillBtn, styles.modalPillBtnGhost, pressed && styles.pressed]}>
                  <Text style={styles.modalPillGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleAddItem}
                  disabled={isAddingItem}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnPrimary,
                    pressed && styles.pressed,
                  ]}>
                  {isAddingItem ? (
                    <ActivityIndicator color={colors.textInverse} size="small" />
                  ) : (
                    <Text style={styles.modalPillPrimaryText}>Add</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </ModalBackdrop>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Cancel Recording Confirmation ── */}
      <ConfirmModal
        visible={cancelConfirmVisible}
        title="Cancel Recording?"
        message="Your current recording will be canceled if you leave this screen."
        confirmLabel="Leave"
        confirmDestructive
        icon="mic-off-outline"
        onConfirm={() => {
          setCancelConfirmVisible(false);
          setVoiceState('idle');
          setVoiceError(null);
          setExtractedItems([]);
          cancelLeaveCallback?.();
        }}
        onCancel={() => {
          setCancelConfirmVisible(false);
          setCancelLeaveCallback(null);
        }}
      />

      {/* ── Delete Item Confirmation ──────── */}
      <ConfirmModal
        visible={!!deleteConfirmItem}
        title="Delete Item?"
        message={deleteConfirmItem ? `Are you sure you want to delete "${deleteConfirmItem.name}"?` : ''}
        confirmLabel="Delete"
        confirmDestructive
        icon="trash-outline"
        onConfirm={performDeleteItem}
        onCancel={() => setDeleteConfirmItem(null)}
        isLoading={isDeleting}
      />

      {/* ── Delete Error ────────────────── */}
      <ConfirmModal
        visible={deleteErrorVisible}
        title="Error"
        message="Failed to delete item. Please try again."
        confirmLabel="OK"
        showCancel={false}
        icon="alert-circle-outline"
        onConfirm={() => setDeleteErrorVisible(false)}
        onCancel={() => setDeleteErrorVisible(false)}
      />

      {/* ── Edit Item Modal ─────────────────── */}
      <Modal
        visible={!!editingItem}
        transparent
        animationType="none"
        onRequestClose={() => {
          setEditingItem(null);
          setEditItemName('');
          setEditItemError(null);
        }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding">
          <ModalBackdrop
            visible={!!editingItem}
            onBackdropPress={() => {
              setEditingItem(null);
              setEditItemName('');
              setEditItemError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <View style={styles.modalTitleRow}>
                <View style={styles.modalTitleIcon}>
                  <Ionicons name="pencil-outline" size={18} color={colors.primary} />
                </View>
                <Text style={font.title}>Rename Item</Text>
              </View>

              {editItemError ? (
                <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 13 }}>{editItemError}</Text>
                </View>
              ) : null}

              <TextInput
                ref={editRef}
                style={styles.itemInput}
                placeholder="Item name"
                placeholderTextColor={colors.textTertiary}
                value={editItemName}
                onChangeText={(text) => {
                  setEditItemName(text);
                  if (editItemError) setEditItemError(null);
                }}
                editable={!isEditingItem}
                returnKeyType="done"
                onSubmitEditing={handleRenameItem}
                maxLength={100}
              />

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setEditingItem(null);
                    setEditItemName('');
                    setEditItemError(null);
                  }}
                  style={({ pressed }) => [styles.modalPillBtn, styles.modalPillBtnGhost, pressed && styles.pressed]}>
                  <Text style={styles.modalPillGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameItem}
                  disabled={isEditingItem}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnPrimary,
                    pressed && styles.pressed,
                  ]}>
                  {isEditingItem ? (
                    <ActivityIndicator color={colors.textInverse} size="small" />
                  ) : (
                    <Text style={styles.modalPillPrimaryText}>Save</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </ModalBackdrop>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Review Modal (after voice extraction) ── */}
      <Modal
        visible={showReviewModal}
        transparent
        animationType="slide"
        onRequestClose={handleCancelReview}>
        <View style={[styles.reviewContainer, { backgroundColor: colors.background }]}>
          <SafeAreaView style={styles.reviewSafeArea}>
            {/* Header */}
            <View style={styles.reviewHeader}>
              <Text style={[font.title, { textAlign: 'center', flex: 1 }]}>Review Items</Text>
            </View>

            {/* Error banner */}
            {reviewError && (
              <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft, marginHorizontal: spacing.xl }]}>
                <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 13 }}>{reviewError}</Text>
              </View>
            )}

            <ScrollView
              style={styles.reviewList}
              contentContainerStyle={styles.reviewListContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>

              <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 13, marginBottom: spacing.md }}>
                Items extracted from your recording. Edit or remove as needed.
              </Text>

              {/* Items */}
              {reviewItems.map((item, index) => (
                <View
                  key={`${item}-${index}`}
                  style={styles.reviewItemCard}>
                  {editingReviewIdx === index ? (
                    <TextInput
                      style={styles.reviewEditInput}
                      value={editingReviewValue}
                      onChangeText={setEditingReviewValue}
                      onBlur={handleFinishEditReviewItem}
                      onSubmitEditing={handleFinishEditReviewItem}
                      autoFocus
                      returnKeyType="done"
                      maxLength={100}
                    />
                  ) : (
                    <Pressable
                      style={styles.reviewItemContent}
                      onPress={() => handleStartEditReviewItem(index)}>
                      <Text style={{ fontFamily: fonts.regular, fontSize: 20, color: colors.textSecondary }}>•</Text>
                      <Text style={[font.body, { flex: 1 }]}>{item}</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => handleRemoveReviewItem(index)}
                    style={({ pressed }) => [styles.reviewItemDelete, pressed && styles.pressed]}>
                    <Ionicons name="close-outline" size={18} color={colors.danger} />
                  </Pressable>
                </View>
              ))}

              {/* Add item */}
              {showReviewAdd ? (
                <View style={styles.reviewItemCard}>
                  <TextInput
                    ref={reviewAddRef}
                    style={[styles.reviewEditInput, { flex: 1 }]}
                    placeholder="Item name"
                    placeholderTextColor={colors.textTertiary}
                    value={reviewAddValue}
                    onChangeText={setReviewAddValue}
                    onSubmitEditing={handleAddReviewItem}
                    returnKeyType="done"
                    maxLength={100}
                  />
                  <Pressable
                    onPress={handleAddReviewItem}
                    style={({ pressed }) => [
                      styles.reviewAddConfirm,
                      { opacity: pressed || !reviewAddValue.trim() ? 0.7 : 1 },
                    ]}>
                    <Text style={styles.reviewAddConfirmText}>Add</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  onPress={() => setShowReviewAdd(true)}
                  style={({ pressed }) => [styles.reviewAddButton, pressed && styles.pressed]}>
                  <Text style={{ color: colors.primary, fontSize: 15, fontFamily: fonts.semiBold, fontWeight: '600' }}>
                    + Add Item
                  </Text>
                </Pressable>
              )}

              {/* Empty state */}
              {reviewItems.length === 0 && (
                <Text style={{ color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xxl }}>
                  No items to save. Add items manually or cancel.
                </Text>
              )}
            </ScrollView>

            {/* Bottom action bar */}
            <View style={[styles.reviewActions, { borderTopColor: colors.border }]}>
              <Pressable
                onPress={handleCancelReview}
                disabled={isSavingReview}
                style={({ pressed }) => [
                  styles.reviewActionBtn,
                  styles.reviewActionCancel,
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.reviewActionCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleConfirmReview}
                disabled={isSavingReview || reviewItems.length === 0}
                style={({ pressed }) => [
                  styles.reviewActionSave,
                  {
                    opacity: pressed || isSavingReview || reviewItems.length === 0 ? 0.5 : 1,
                  },
                ]}>
                {isSavingReview ? (
                  <ActivityIndicator color={colors.textInverse} size="small" />
                ) : (
                  <Text style={styles.reviewActionSaveText}>
                    Save {reviewItems.length > 0 ? `(${reviewItems.length})` : ''}
                  </Text>
                )}
              </Pressable>
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      {/* ── Box Action Sheet (header ⋯; Home rows long-press into the same
             sheet) — card rows + ghost cancel, like every other sheet. ── */}
      <BottomSheet
        visible={showBoxSheet}
        onClose={() => setShowBoxSheet(false)}
        sheetStyle={{
          backgroundColor: colors.surface,
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.xs,
          gap: spacing.md,
        }}>
        <BottomSheetDraggableArea style={styles.boxSheetTitleWrap}>
          <Text style={[font.headline, styles.boxSheetTitle]}>{box?.box_number}</Text>
        </BottomSheetDraggableArea>

        <Pressable
          style={({ pressed }) => [styles.boxSheetOption, pressed && { opacity: 0.7 }]}
          onPress={() => {
            setEditBoxName(box.box_number);
            setEditBoxError(null);
            setShowBoxSheet(false);
            setEditingBox(box);
          }}>
          <View style={[styles.boxSheetOptionIcon, { backgroundColor: colors.primarySoft }]}>
            <Ionicons name="pencil-outline" size={20} color={colors.primary} />
          </View>
          <Text style={[font.bodyMedium, { flex: 1 }]}>Rename</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.boxSheetOption, pressed && { opacity: 0.7 }]}
          onPress={() => {
            setShowBoxSheet(false);
            setDeleteConfirmBox(box);
          }}>
          <View style={[styles.boxSheetOptionIcon, { backgroundColor: colors.dangerSoft }]}>
            <Ionicons name="trash-outline" size={20} color={colors.danger} />
          </View>
          <Text style={[font.bodyMedium, { flex: 1 }, { color: colors.danger }]}>Delete</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.boxSheetCancel, pressed && { opacity: 0.7 }]}
          onPress={() => setShowBoxSheet(false)}>
          <Text style={[font.headline, { color: colors.primary }]}>Cancel</Text>
        </Pressable>
      </BottomSheet>

      {/* ── Rename Box Modal ───────────── */}
      <Modal
        visible={!!editingBox}
        transparent
        animationType="none"
        onRequestClose={() => {
          setEditingBox(null);
          setEditBoxName('');
          setEditBoxError(null);
        }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="padding">
          <ModalBackdrop
            visible={!!editingBox}
            onBackdropPress={() => {
              setEditingBox(null);
              setEditBoxName('');
              setEditBoxError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <View style={styles.modalTitleRow}>
                <View style={styles.modalTitleIcon}>
                  <Ionicons name="pencil-outline" size={18} color={colors.primary} />
                </View>
                <Text style={font.title}>Rename Box</Text>
              </View>

              {editBoxError ? (
                <View style={[styles.errorBox, { backgroundColor: colors.dangerSoft }]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.danger, fontSize: 13 }}>{editBoxError}</Text>
                </View>
              ) : null}

              <TextInput
                ref={editBoxRef}
                style={styles.itemInput}
                placeholder="Box label (e.g. Box 1)"
                placeholderTextColor={colors.textTertiary}
                value={editBoxName}
                onChangeText={(text) => {
                  setEditBoxName(text);
                  if (editBoxError) setEditBoxError(null);
                }}
                editable={!isEditingBox}
                returnKeyType="done"
                onSubmitEditing={handleRenameBox}
                maxLength={100}
              />

              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setEditingBox(null);
                    setEditBoxName('');
                    setEditBoxError(null);
                  }}
                  style={({ pressed }) => [styles.modalPillBtn, styles.modalPillBtnGhost, pressed && styles.pressed]}>
                  <Text style={styles.modalPillGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameBox}
                  disabled={isEditingBox}
                  style={({ pressed }) => [
                    styles.modalPillBtn,
                    styles.modalPillBtnPrimary,
                    pressed && styles.pressed,
                  ]}>
                  {isEditingBox ? (
                    <ActivityIndicator color={colors.textInverse} size="small" />
                  ) : (
                    <Text style={styles.modalPillPrimaryText}>Save</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </ModalBackdrop>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Delete Box Confirmation ──────── */}
      <ConfirmModal
        visible={!!deleteConfirmBox}
        title="Delete Box?"
        message={
          deleteConfirmBox
            ? `Are you sure you want to delete "${deleteConfirmBox.box_number}"? All items in this box will also be deleted.${
                boxPhotoCount > 0 ? ' The photos in this box will also be deleted.' : ''
              }`
            : ''
        }
        confirmLabel="Delete"
        confirmDestructive
        icon="trash-outline"
        onConfirm={performDeleteBox}
        onCancel={() => setDeleteConfirmBox(null)}
        isLoading={isDeletingBox}
      />

      {/* ── Delete Box Error ─────────────── */}
      <ConfirmModal
        visible={deleteBoxErrorVisible}
        title="Error"
        message="Failed to delete box. Please try again."
        confirmLabel="OK"
        showCancel={false}
        icon="alert-circle-outline"
        onConfirm={() => setDeleteBoxErrorVisible(false)}
        onCancel={() => setDeleteBoxErrorVisible(false)}
      />

      {/* ── Label Prompt ───────────── */}
      <LabelPromptModal
        visible={showLabelPrompt}
        boxNumber={box?.box_number ?? ''}
        onWroteIt={handleWroteIt}
        onSkip={handleSkipLabel}
        loading={isSettingLabel}
      />
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },

  // ── Box action sheet (header ⋯) ──
  // Card rows + ghost cancel, matching components/photo-source-sheet.tsx.
  boxSheetTitleWrap: {
    marginHorizontal: -spacing.xl, // stretch the drag surface over the full sheet width
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  boxSheetTitle: {
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  boxSheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderCurve: 'continuous',
  },
  boxSheetOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  boxSheetCancel: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
  },
  centeredContainer: {
    flex: 1,
    justifyContent: 'center',
    flexDirection: 'row',
  },
  centeredSafeArea: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.lg,
  },
  scrollContent: {
    // Space between the header (title row) and the hero record card.
    paddingTop: spacing.lg,
    paddingBottom: 120,
  },
  pressed: {
    opacity: 0.7,
  },

  // ── Header accessory — circular white chip matching the back button ──
  headerAction: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Hero Recording Card ─────────────
  heroCard: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.xxl,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.md,
    ...shadow.card,
  },
  // Soft yellow halo behind the mic disc: the same "icon" treatment Home gives
  // its move tiles (moveSoft tile + amber glyph), scaled up.
  micHalo: {
    width: 168,
    height: 168,
    borderRadius: 84,
    backgroundColor: colors.moveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micHaloDisabled: { opacity: 0.6 },
  heroTitle: {
    fontFamily: fonts.bold,
    fontWeight: '700',
    fontSize: 19,
    color: colors.textPrimary,
    textAlign: 'center',
  },
  // Recording state goes navy (the app's dark anchor, as on Home's progress
  // card) with yellow accents — the violet stays for buttons.
  heroCardRecording: {
    backgroundColor: colors.navy,
  },
  heroCardDone: {
    backgroundColor: colors.packedSoft,
  },
  // Mic disc inside the halo — solid accent yellow (the colour Home reserves
  // for icon/accent fills), NOT the violet used for buttons.
  micButton: {
    width: 116,
    height: 116,
    borderRadius: 58,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accentDeep,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 6,
  },
  micButtonDisabled: {
    backgroundColor: colors.textTertiary,
    opacity: 0.5,
  },
  micButtonActive: {
    width: 120,
    height: 120,
    borderRadius: 60,
    // Same accent disc as the idle state, on the navy recording card.
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },

  // ── Example-phrases ticker ──
  phraseTrack: {
    alignSelf: 'stretch',
    height: 22,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  phraseText: {
    position: 'absolute',
    left: 0,
    fontFamily: fonts.italic,
    fontStyle: 'italic',
    fontSize: 14,
    color: colors.textSecondary,
  },
  // "N recordings left" — soft gray pill at the foot of the hero card.
  creditsPill: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
  },
  creditsPillText: {
    fontSize: 14,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  sharedCreditsHint: {
    marginTop: spacing.sm,
    fontSize: 12,
    fontFamily: fonts.regular,
    color: colors.textTertiary,
    textAlign: 'center',
  },
  statusText: {
    marginTop: spacing.lg,
    fontSize: 16,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textSecondary,
  },
  listeningText: {
    fontSize: 16,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textInverse,
  },
  recordingTimer: {
    fontSize: 40,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textInverse,
    fontVariant: ['tabular-nums'],
  },
  stopButton: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
  },
  stopButtonText: {
    color: colors.danger,
    fontSize: 17,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  autoStoppedText: {
    marginTop: spacing.sm,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textInverse,
    textAlign: 'center',
  },
  doneTitle: {
    fontSize: 17,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.packed,
    textAlign: 'center',
  },
  extractedPreview: {
    width: '100%',
    gap: 2,
    paddingHorizontal: spacing.md,
  },
  extractedItem: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 22,
    paddingVertical: 1,
  },
  extractedMore: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textTertiary,
    marginTop: 2,
  },
  recordAgainBtn: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  recordAgainText: {
    color: colors.primary,
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },

  // ── Error ────────────────────────────
  errorTitle: {
    fontSize: 17,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.danger,
    textAlign: 'center',
  },
  errorText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorActions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  dismissBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  dismissBtnText: {
    color: colors.textSecondary,
    fontFamily: fonts.regular,
    fontSize: 15,
  },
  tryAgainBtn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  },
  tryAgainBtnText: {
    color: colors.textInverse,
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },

  // ── Items Section ─────────────────────
  itemsSection: {
    paddingHorizontal: spacing.xl,
    // Clearance for the floating "Add item" pill.
    paddingBottom: 80,
  },
  itemsLoading: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  // Grouped list of item rows (mockup: one white card per item).
  itemsList: {
    gap: spacing.sm,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    ...shadow.card,
  },
  itemDot: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.itemSoft,
    borderCurve: 'continuous',
  },
  itemName: {
    fontSize: 16,
    color: colors.textPrimary,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    flex: 1,
  },
  itemActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  itemActionBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Empty State (dashed card — same language as Home's empty room) ──
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.dividerStrong,
    backgroundColor: colors.surfaceMuted,
    borderCurve: 'continuous',
    gap: spacing.sm,
  },
  emptyIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    // Icon tile, not a button — same soft-yellow/amber pair as the section
    // headers (the violet "Add first item" pill below stays a button).
    backgroundColor: colors.moveSoft,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  emptyDescription: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    height: 48,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    borderCurve: 'continuous',
  },
  emptyAddText: {
    color: colors.textInverse,
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  // ── Back button (error state) ────────
  backButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },

  // ── FAB ──────────────────────────────
  // Labeled pill — same shape as Home's "+ Add box" FAB.
  fab: {
    position: 'absolute',
    bottom: spacing.xxl,
    right: spacing.xl,
    height: 52,
    minHeight: 52,
    borderRadius: 26,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    ...shadow.card,
    elevation: 4,
  },
  fabText: {
    color: colors.textInverse,
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },

  // ── Add/Rename Item Input (same treatment as Home's New box field) ──
  itemInput: {
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    // Height owns the vertical rhythm; zero padding + Android centering keeps
    // the typed text dead-centre on both platforms.
    paddingVertical: 0,
    textAlignVertical: 'center',
    height: 56,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 17,
    color: colors.textPrimary,
  },

  // ── Modal ───────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  modalCard: {
    borderRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.lg,
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
  },
  modalTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  modalTitleIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  modalActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  modalPillBtn: {
    flex: 1,
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  modalPillBtnGhost: {
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  modalPillBtnPrimary: {
    backgroundColor: colors.primary,
  },
  modalPillGhostText: {
    color: colors.primary,
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  modalPillPrimaryText: {
    color: colors.textInverse,
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  errorBox: {
    padding: spacing.sm,
    borderRadius: radius.sm,
  },

  // ── Review Modal ─────────────────────
  reviewContainer: {
    flex: 1,
  },
  reviewSafeArea: {
    flex: 1,
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  reviewList: {
    flex: 1,
  },
  reviewListContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  reviewItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  reviewItemContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  reviewItemDelete: {
    padding: spacing.xs,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reviewEditInput: {
    flex: 1,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.sm,
    // Even inset on all four sides — no surrounding height, so the text is
    // centred by this padding (plus Android's centering).
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    textAlignVertical: 'center',
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reviewAddConfirm: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
  },
  reviewAddConfirmText: {
    color: colors.textInverse,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 14,
  },
  reviewAddButton: {
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  reviewActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.md,
  },
  reviewActionBtn: {
    height: 52,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.pill,
    justifyContent: 'center',
    alignItems: 'center',
    borderCurve: 'continuous',
  },
  reviewActionCancel: {
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  reviewActionCancelText: {
    color: colors.primary,
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  reviewActionSave: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
    borderCurve: 'continuous',
  },
  reviewActionSaveText: {
    color: colors.textInverse,
    fontSize: 15,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
});

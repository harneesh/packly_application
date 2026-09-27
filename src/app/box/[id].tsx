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
  Platform,
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
import { fetchCreditBalance, type CreditBalance } from '@/services/credits';
import ConfirmModal from '@/components/confirm-modal';
import ModalBackdrop from '@/components/modal-backdrop';
import LabelPromptModal from '@/components/label-prompt-modal';
import BoxPhotos from '@/components/box-photos';
import SectionHeader from '../../../packly-ui/components/SectionHeader';
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
            backgroundColor: '#FFFFFF',
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

  // ── AI credits (1 credit = 1 voice recording) ──
  // Cached for a minute; updated optimistically after each recording and
  // refetched when the server reports OUT_OF_CREDITS.
  const { data: credits } = useQuery({
    queryKey: ['credits'],
    queryFn: fetchCreditBalance,
    staleTime: 60 * 1000,
  });
  const creditsRemaining = credits?.balance ?? null;
  const outOfCredits = creditsRemaining === 0;

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
    if (creditsRemaining === 0) {
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
  }, [audioRecorder, creditsRemaining]);

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

      const result = await processAudio(uri);

      if (result.success) {
        setExtractedItems(result.items);
        setVoiceState('done');
        // Optimistically sync the cached balance with the server's count.
        if (typeof result.creditsRemaining === 'number') {
          queryClient.setQueryData<CreditBalance>(['credits'], (prev) => ({
            balance: result.creditsRemaining!,
            expiresAt: prev?.expiresAt ?? null,
          }));
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

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={styles.container}>
        <ScreenHeader onBack={handleBack} title={box.box_number} large />

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>

          {/* ── Hero Recording Card ────────────── */}

          {/* ── Voice Section ──────────────────── */}
          <View>
            <SectionHeader icon="mic-outline" title="Voice" style={{ paddingHorizontal: spacing.xl }} />
            <Text style={styles.voiceHint}>
              Speak naturally — Packly turns your recording into items.
            </Text>

          {voiceState === 'idle' && (
            <View style={styles.heroCard}>
              <Pressable
                onPress={startRecording}
                disabled={outOfCredits}
                style={({ pressed }) => [
                  styles.micButton,
                  pressed && { transform: [{ scale: 0.95 }] },
                  outOfCredits && styles.micButtonDisabled,
                ]}>
                <Ionicons name="mic-outline" size={52} color="#FFFFFF" />
              </Pressable>
              <ExamplePhrases />
              {creditsRemaining !== null && (
                <Text style={styles.creditsLeft}>
                  {outOfCredits
                    ? 'Upgrade to Pro for more recordings'
                    : `${creditsRemaining} recording${creditsRemaining !== 1 ? 's' : ''} left`}
                </Text>
              )}
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
                <Ionicons name="mic" size={52} color="#FFFFFF" />
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
          <BoxPhotos boxId={id} />

          {/* ── Items Section ──────────────────────── */}
          <View style={styles.itemsSection}>
            <SectionHeader
              title="Items in this Box"
              meta={`Items: ${items?.length ?? 0}`}
              style={{ paddingHorizontal: spacing.xl }}
            />

            {itemsLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : items && items.length > 0 ? (
              <View style={styles.itemsList}>
                    {items.map((item) => {
                      const itemKey = item.id;
                      return (
                        <View key={itemKey} style={styles.itemRow}>
                          <View style={styles.itemRowLeft}>
                            <View style={[styles.itemDot, { backgroundColor: colors.itemSoft }]}>
                              <Ionicons name="cube-outline" size={12} color={colors.item} />
                            </View>
                            <Text style={styles.itemName} numberOfLines={1} ellipsizeMode="tail">
                              {item.name}
                            </Text>
                          </View>
                          <View style={styles.itemActions}>
                            <Pressable
                              onPress={() => {
                                setEditItemName(item.name);
                                setEditItemError(null);
                                setEditingItem(item);
                              }}
                              style={({ pressed }) => [
                                styles.itemActionBtn,
                                pressed && { opacity: 0.6 },
                              ]}>
                              <Ionicons name="pencil-outline" size={16} color={colors.textTertiary} />
                            </Pressable>
                            <Pressable
                              onPress={() => handleDeleteItem(item)}
                              style={({ pressed }) => [
                                styles.itemActionBtn,
                                pressed && { opacity: 0.6 },
                              ]}>
                              <Ionicons name="trash-outline" size={16} color={colors.danger} />
                            </Pressable>
                          </View>
                        </View>
                      );
                    })}
              </View>
            ) : (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconContainer}>
                  <Ionicons name="cube-outline" size={36} color={colors.textTertiary} />
                </View>
                <Text style={styles.emptyTitle}>No items yet</Text>
                <Text style={styles.emptyDescription}>
                  Record your voice or add items manually.
                </Text>
              </View>
            )}
          </View>
        </ScrollView>

        {/* ── Floating Add Button (always visible) ── */}
        <Pressable
          onPress={() => setShowAddItem(true)}
          style={({ pressed }) => [
            styles.fab,
            pressed && { transform: [{ scale: 0.92 }] },
          ]}>
          <Ionicons name="add" size={28} color="#FFFFFF" />
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
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ModalBackdrop
            visible={showAddItem}
            onBackdropPress={() => {
              setShowAddItem(false);
              setItemName('');
              setAddItemError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <Text style={[font.headline, { marginBottom: spacing.sm }]}>Add Item</Text>

              {addItemError ? (
                <View style={[styles.errorBox, { backgroundColor: '#FEE2E2' }]}>
                  <Text style={{ fontFamily: fonts.regular, color: '#DC2626', fontSize: 13 }}>{addItemError}</Text>
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
                  style={({ pressed }) => [styles.modalCancelBtn, pressed && styles.pressed]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 15 }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleAddItem}
                  disabled={isAddingItem}
                  style={({ pressed }) => [
                    styles.modalSaveBtn,
                    { backgroundColor: colors.primary, opacity: isAddingItem || pressed ? 0.7 : 1 },
                  ]}>
                  {isAddingItem ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.modalSaveText}>Add</Text>
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
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ModalBackdrop
            visible={!!editingItem}
            onBackdropPress={() => {
              setEditingItem(null);
              setEditItemName('');
              setEditItemError(null);
            }}>
            <View style={[styles.modalCard, { backgroundColor: colors.surface }]}>
              <Text style={[font.headline, { marginBottom: spacing.sm }]}>Rename Item</Text>

              {editItemError ? (
                <View style={[styles.errorBox, { backgroundColor: '#FEE2E2' }]}>
                  <Text style={{ fontFamily: fonts.regular, color: '#DC2626', fontSize: 13 }}>{editItemError}</Text>
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
                  style={({ pressed }) => [styles.modalCancelBtn, pressed && styles.pressed]}>
                  <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 15 }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleRenameItem}
                  disabled={isEditingItem}
                  style={({ pressed }) => [
                    styles.modalSaveBtn,
                    { backgroundColor: colors.primary, opacity: isEditingItem || pressed ? 0.7 : 1 },
                  ]}>
                  {isEditingItem ? (
                    <ActivityIndicator color="#FFFFFF" size="small" />
                  ) : (
                    <Text style={styles.modalSaveText}>Save</Text>
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
              <Text style={[font.headline, { textAlign: 'center', flex: 1 }]}>Review Items</Text>
            </View>

            {/* Error banner */}
            {reviewError && (
              <View style={[styles.errorBox, { backgroundColor: '#FEE2E2', marginHorizontal: spacing.xl }]}>
                <Text style={{ fontFamily: fonts.regular, color: '#DC2626', fontSize: 13 }}>{reviewError}</Text>
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
                style={({ pressed }) => [styles.reviewActionBtn, pressed && styles.pressed]}>
                <Text style={{ fontFamily: fonts.regular, color: colors.textSecondary, fontSize: 16 }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleConfirmReview}
                disabled={isSavingReview || reviewItems.length === 0}
                style={({ pressed }) => [
                  styles.reviewActionSave,
                  {
                    backgroundColor: colors.primary,
                    opacity: pressed || isSavingReview || reviewItems.length === 0 ? 0.5 : 1,
                  },
                ]}>
                {isSavingReview ? (
                  <ActivityIndicator color="#FFFFFF" size="small" />
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

      {/* ── Label Prompt ────────────────── */}
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

  // ── Hero Recording Card ─────────────
  heroCard: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.xxl,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xxl,
    alignItems: 'center',
    gap: spacing.md,
    ...shadow.card,
  },
  heroCardRecording: {
    backgroundColor: '#2563EB',
  },
  heroCardDone: {
    backgroundColor: '#F0FDF4',
  },
  micButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  micButtonDisabled: {
    backgroundColor: colors.textTertiary,
    opacity: 0.5,
  },
  micButtonActive: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  voiceHint: {
    paddingHorizontal: spacing.xl,
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textTertiary,
    marginBottom: spacing.md,
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
  creditsLeft: {
    marginTop: spacing.xs,
    fontSize: 13,
    fontFamily: fonts.medium,
    fontWeight: '500',
    color: colors.textTertiary,
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
    color: '#FFFFFF',
  },
  recordingTimer: {
    fontSize: 40,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
  stopButton: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
    backgroundColor: '#FFFFFF',
    borderRadius: radius.pill,
  },
  stopButtonText: {
    color: '#DC2626',
    fontSize: 17,
    fontFamily: fonts.bold,
    fontWeight: '700',
  },
  autoStoppedText: {
    marginTop: spacing.sm,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: '#FFFFFF',
    textAlign: 'center',
  },
  doneTitle: {
    fontSize: 17,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.success,
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
    borderRadius: radius.lg,
  },
  tryAgainBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },

  // ── Items Section ─────────────────────
  itemsSection: {
    paddingHorizontal: spacing.xl,
  },
  itemsLoading: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  itemsList: {
    gap: spacing.sm,
    paddingBottom: 80,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.lg,
    ...shadow.card,
  },
  itemRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  itemDot: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemName: {
    fontSize: 15,
    color: colors.textPrimary,
    fontFamily: fonts.medium,
    fontWeight: '500',
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

  // ── Empty State ──────────────────────
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl,
    gap: spacing.md,
  },
  emptyIconContainer: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  emptyDescription: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  // ── Back button (error state) ────────
  backButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },

  // ── FAB ──────────────────────────────
  fab: {
    position: 'absolute',
    bottom: spacing.xxl,
    right: spacing.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
    elevation: 4,
  },

  // ── Add Item Input ────────────────────
  itemInput: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    height: 56,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.textPrimary,
  },

  // ── Modal ───────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,22,0.45)',
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
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  modalCancelBtn: {
    paddingHorizontal: spacing.lg,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalSaveBtn: {
    paddingHorizontal: spacing.xxl,
    height: 52,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 60,
  },
  modalSaveText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
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
    padding: spacing.sm,
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
    color: '#FFFFFF',
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
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    height: 52,
    justifyContent: 'center',
  },
  reviewActionSave: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.lg,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
  },
  reviewActionSaveText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
  },
});

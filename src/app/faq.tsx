// app/faq.tsx
// FAQ — a grouped-list page of the most common / arising Packly questions.
//
// Reached from Settings → Help Centre → FAQ. Design follows the grouped-list
// convention of big apps: rows grouped into bordered white groups on the
// muted page background, a bold uppercase eyebrow title per group, rows flush
// inside their group, and right-chevrons ONLY on the expandable rows (they
// rotate 90° when open). Expand/collapse uses LayoutAnimation — the same
// native mechanism as the move switcher; a static page this small lays out
// instantly with no JS-frame cost.
//
// If real users start asking new questions, add them to QUESTIONS below.

import { useState } from 'react';
import {
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import ScreenHeader from '../../packly-ui/components/ScreenHeader';
import { colors, spacing, font, radius, fonts, shadow } from '../../packly-ui/theme';

// ──────────────────────────────────────────
// Content — grouped by theme
// ──────────────────────────────────────────

const PACKING: Array<{ q: string; a: string }> = [
  {
    q: 'What counts as an AI recording?',
    a: 'Every voice note you record is one AI recording — Packly listens and turns what you say into box items automatically.',
  },
  {
    q: 'How do I add items to a box?',
    a: 'Open a box and tap the mic to record, or type items in manually with the add field.',
  },
  {
    q: 'Can I add photos to a box?',
    a: 'Yes — open a box and use the Photos section. Photo uploads are a Pro feature.',
  },
  {
    q: 'What happens when I run out of credits?',
    a: 'You can keep typing items manually. Upgrade to Pro for 200 recordings per billing period — free credits never expire.',
  },
];

const MOVES_ROOMS: Array<{ q: string; a: string }> = [
  {
    q: 'How do I invite someone to my move?',
    a: 'Open your move and share the invite code — they join with it and see every room, box, and item.',
  },
  {
    q: 'Can more than one person pack the same box?',
    a: 'Yes. Everyone in a move can add items, record voice notes, and upload photos — changes appear live for the whole team.',
  },
  {
    q: 'What do the numbers on boxes mean?',
    a: 'Each box gets a number inside its room (like "Box 3") so you can label the physical box and find it again instantly.',
  },
];

const ACCOUNT: Array<{ q: string; a: string }> = [
  {
    q: 'Do I need Pro to try Packly?',
    a: 'No — every account starts with free voice credits, and your moves, rooms, and boxes are unlimited on the free plan.',
  },
  {
    q: 'How do I delete my account?',
    a: 'Settings → Delete Account. Deleting wipes your remaining credits and signs you out permanently — shared moves stay available to your collaborators.',
  },
];

const GROUPS: Array<{ title: string; items: Array<{ q: string; a: string }> }> = [
  { title: 'Packing & voice', items: PACKING },
  { title: 'Moves, rooms & boxes', items: MOVES_ROOMS },
  { title: 'Account & plan', items: ACCOUNT },
];

// ──────────────────────────────────────────
// Screen
// ──────────────────────────────────────────

export default function FaqScreen() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const toggle = (key: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenKey((cur) => (cur === key ? null : key));
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={styles.container}>
        <ScreenHeader onBack={() => router.back()} title="FAQ" />

        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + spacing.xxxl },
          ]}
          showsVerticalScrollIndicator={false}>

          {GROUPS.map((group) => (
            <View key={group.title} style={styles.groupWrap}>
              <Text style={font.eyebrow}>{group.title}</Text>
              <View style={styles.group}>
                {group.items.map((item, index) => {
                  const key = `${group.title}:${item.q}`;
                  const isOpen = openKey === key;
                  return (
                    <View key={key}>
                      {index > 0 && (
                        <View style={[styles.divider, { backgroundColor: colors.divider }]} />
                      )}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: isOpen }}
                        onPress={() => toggle(key)}
                        style={({ pressed }) => [
                          styles.row,
                          pressed && { opacity: 0.6 },
                        ]}>
                        <Text style={styles.question} numberOfLines={2}>
                          {item.q}
                        </Text>
                        {/* Right chevron = this row expands. Rotates 90° when open. */}
                        <Ionicons
                          name="chevron-forward"
                          size={16}
                          color={colors.primary}
                          style={isOpen ? styles.chevronOpen : undefined}
                        />
                      </Pressable>
                      {isOpen && (
                        <Text style={styles.answer}>{item.a}</Text>
                      )}
                    </View>
                  );
                })}
              </View>
            </View>
          ))}

          <Text style={styles.footerNote}>
            Still stuck? Settings → Help Centre → Contact Support
          </Text>
        </ScrollView>
      </View>
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
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    gap: spacing.xl,
  },

  // ── Groups (the iOS grouped-list look) ──
  groupWrap: {
    gap: spacing.sm,
  },
  group: {
    // White card on the periwinkle canvas — same card language as every
    // other list in the redesign.
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderCurve: 'continuous',
    paddingHorizontal: spacing.lg,
    ...shadow.card,
  },

  // ── Rows ──────────────────────────────
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  question: {
    flex: 1,
    fontFamily: fonts.semiBold,
    fontWeight: '600',
    fontSize: 15,
    color: colors.textPrimary,
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }],
  },
  answer: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 21,
    color: colors.textSecondary,
    // Sit under the question text, aligned with it (past the chevron column).
    paddingRight: 28,
    paddingBottom: spacing.lg,
    marginTop: -spacing.xs,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },

  // ── Footer ────────────────────────────
  footerNote: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textTertiary,
    textAlign: 'center',
  },
});

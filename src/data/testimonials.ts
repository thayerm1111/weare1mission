/**
 * TESTIMONIALS  —  PLACEHOLDER CONTENT.
 * ⚠️  Every testimonial below is placeholder text and MUST be replaced with
 * real, permission-granted quotes before launch. Do NOT use income or results
 * claims. Focus on community, growth, and personal development.
 */
export interface Testimonial {
  id: string;
  quote: string;
  name: string;       // PLACEHOLDER
  role: string;       // PLACEHOLDER (e.g. "Community Member")
  location: string;   // PLACEHOLDER
  image?: string;     // optional photo (placeholder)
  isPlaceholder: true;
}

export const testimonials: Testimonial[] = [
  {
    id: "t1",
    quote:
      "The community changed how I show up every day. Being around people with real goals raised my standards.",
    name: "Placeholder Name",
    role: "Community Member",
    location: "Placeholder City",
    isPlaceholder: true,
  },
  {
    id: "t2",
    quote:
      "I've grown more confident and consistent since I got connected. The mentorship makes all the difference.",
    name: "Placeholder Name",
    role: "Community Member",
    location: "Placeholder City",
    isPlaceholder: true,
  },
  {
    id: "t3",
    quote:
      "I came to learn a skill and stayed for the people. The support here is genuinely different.",
    name: "Placeholder Name",
    role: "Community Member",
    location: "Placeholder City",
    isPlaceholder: true,
  },
  {
    id: "t4",
    quote:
      "The structure helped me build discipline. Small daily actions turned into real personal growth.",
    name: "Placeholder Name",
    role: "Community Member",
    location: "Placeholder City",
    isPlaceholder: true,
  },
];

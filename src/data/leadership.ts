/**
 * LEADERSHIP  —  edit leader profiles here.
 * ⚠️  Use PLACEHOLDER info until real details are provided. Do NOT invent
 * accomplishments, ranks, or income. Leave fields as "" to hide them.
 */
export interface Leader {
  id: string;
  name: string;
  position: string;
  rank: string;       // leave "" if not applicable
  location: string;
  bio: string;
  expertise: string[];
  image: string;      // placeholder path
  instagram?: string;
  facebook?: string;
  telegram?: string;
  videoUrl?: string;  // optional intro video embed
  featured?: boolean;
  isPlaceholder: true;
}

export const leaders: Leader[] = [
  {
    id: "leader-1",
    name: "Placeholder Leader One",
    position: "Community Leader",
    rank: "",
    location: "Placeholder City",
    bio: "Short placeholder biography. Replace with a real introduction focused on service, values, and how this leader helps members grow.",
    expertise: ["Mentorship", "Leadership Development", "Community Building"],
    image: "/images/leaders/leader-1.jpg",
    instagram: "#",
    facebook: "#",
    telegram: "#",
    featured: true,
    isPlaceholder: true,
  },
  {
    id: "leader-2",
    name: "Placeholder Leader Two",
    position: "Training Leader",
    rank: "",
    location: "Placeholder City",
    bio: "Short placeholder biography. Replace with real details describing this leader's focus and approach to helping others.",
    expertise: ["Training", "Duplication", "Accountability"],
    image: "/images/leaders/leader-2.jpg",
    instagram: "#",
    telegram: "#",
    featured: true,
    isPlaceholder: true,
  },
  {
    id: "leader-3",
    name: "Placeholder Leader Three",
    position: "Community Leader",
    rank: "",
    location: "Placeholder City",
    bio: "Short placeholder biography. Replace with a real introduction. Keep it authentic and free of income or results claims.",
    expertise: ["Personal Development", "Consistency", "Events"],
    image: "/images/leaders/leader-3.jpg",
    instagram: "#",
    facebook: "#",
    isPlaceholder: true,
  },
  {
    id: "leader-4",
    name: "Placeholder Leader Four",
    position: "Community Leader",
    rank: "",
    location: "Placeholder City",
    bio: "Short placeholder biography. Replace with real details before launch.",
    expertise: ["Social Media", "Mindset", "Mentorship"],
    image: "/images/leaders/leader-4.jpg",
    instagram: "#",
    telegram: "#",
    isPlaceholder: true,
  },
];

export const leadershipValues = [
  { title: "Service", description: "Leadership starts with putting others first and adding value without keeping score." },
  { title: "Consistency", description: "Small, repeated actions build trust and momentum over time." },
  { title: "Responsibility", description: "Leaders own outcomes and set the standard by example." },
  { title: "Development", description: "We grow people — investing in skills, character, and confidence." },
  { title: "Example", description: "We lead from the front and never ask more than we're willing to do." },
  { title: "Mentorship", description: "Real leaders reproduce leaders, not just followers." },
];

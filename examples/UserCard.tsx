import { useState, useEffect } from "react";

interface User {
  id: string;
  name: string;
  avatar: string;
  email: string;
}

interface Props {
  userId: string;
  onSelect?: (user: User) => void;
}

/** Renders a profile card and handles favorite toggling. */
export function UserCard({ userId, onSelect }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [isFavorite, setIsFavorite] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/users/${userId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setUser(data);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const onClick = () => {
    if (!user) return;
    if (onSelect) onSelect(user);
  };

  const toggleFavorite = () => {
    setIsFavorite((prev) => {
      const next = !prev;
      fetch(`/api/users/${userId}/favorite`, {
        method: "POST",
        body: JSON.stringify({ favorite: next }),
      });
      return next;
    });
  };

  if (!user) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="card" onClick={onClick}>
      <img src={user.avatar} alt={user.name} />
      <div className="card-body">
        <h3>{user.name}</h3>
        <p>{user.email}</p>
        <button onClick={toggleFavorite}>
          {isFavorite ? "★" : "☆"}
        </button>
      </div>
    </div>
  );
}

export const Avatar = ({ user }: { user: User }) => {
  return <img src={user.avatar} alt={user.name} className="avatar" />;
};

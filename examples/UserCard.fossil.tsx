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

  useEffect(() => { /* fossil:examples/UserCard.tsx#UserCard.useEffect 10L */ }, [userId]);

  const onClick = () => { /* fossil:examples/UserCard.tsx#UserCard.onClick 3L */ };

  const toggleFavorite = () => { /* fossil:examples/UserCard.tsx#UserCard.toggleFavorite 9L */ };

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



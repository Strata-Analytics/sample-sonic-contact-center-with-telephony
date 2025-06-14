import { useState, useEffect } from 'react';

const USER = "strata";
const PASS = "strata";

export const useAuth = () => {
  const [authorized, setAuthorized] = useState(
    !!localStorage.getItem("auth-ok")
  );

  useEffect(() => {
    const isAuthorized = localStorage.getItem("auth-ok");
    if (isAuthorized === "true") {
      setAuthorized(true);
    } else {
      const user = prompt("Usuario:");
      const pass = prompt("Contraseña:");

      if (user === USER && pass === PASS) {
        localStorage.setItem("auth-ok", "true");
        window.location.reload();
      } else {
        alert("Acceso denegado");
        window.location.reload();
      }
    }
  }, []);

  return { authorized };
};
import React from "react";

interface FooterProps {
  connectionStatus: string;
  statusMessage: string;
}

const Footer: React.FC<FooterProps> = ({ connectionStatus, statusMessage }) => {
  return (
    <div className="flex justify-between items-center bg-white p-3 rounded-lg shadow text-xs text-gray-500 flex-shrink-0 mt-auto">
      <div>Amazon Nova Analytics v1.3.5</div>
      <div>Powered by Amazon Nova Speech and Text AI Models</div>
      <div id="connection-status" className={`status ${connectionStatus}`}>
        {statusMessage}
      </div>
    </div>
  );
};

export default Footer;
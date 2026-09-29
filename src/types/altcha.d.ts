import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'altcha-widget': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        challenge?: string;
        name?: string;
        auto?: 'off' | 'onfocus' | 'onload' | 'onsubmit';
        type?: 'native' | 'checkbox' | 'switch';
        workers?: number;
        configuration?: string;
      };
    }
  }
}
